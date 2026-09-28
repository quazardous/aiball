/**
 * #3063 — subscriptions: the value, then the changes as data; who may
 * subscribe to what; a view's rows equal the list's; the replay of what was
 * missed; nothing left behind when a connection or subscription goes.
 */
import { test, after } from "node:test";
import { testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3063-subs-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { subscriptionCountForTests } = await import("./subscriptions.js");
const { getMethod } = await import("./methods.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { submitMessage, moveTicketTo } = await import("../messages.js");
const { setAgentBar } = await import("../agent-bar-store.js");
const { WebSocket } = await import("ws");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
for (const p of ["p-subs", "p-away"]) {
    createProject({ name: p });
    upsertSubscription("worker", p, "owner");
    upsertSubscription("boss", p, "owner");
}
const ticket = (title: string) => submitMessage({ project: "p-subs", kind: "ticket_created", title, body: "b", by_agent: "boss" }).id;

const sockPath = join(home, "bus.sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    uds.closeAllConnections();
    uds.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Ev = { subscription: string; subject: string; seq: number; data: unknown };

/** A raw connection, to see every notification. */
async function open(consumer: string) {
    const ws = new WebSocket(`ws+unix:${sockPath}:/bus`, { headers: { "x-aiball-consumer": consumer } });
    clients.push(ws);
    const events: Ev[] = [];
    let nextId = 1;
    const pending = new Map<number, (r: { result?: unknown; error?: { code: number; data?: { code: string } } }) => void>();
    const hello = await new Promise<{ epoch: string }>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)).params)));
    ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.method === "bus.event") events.push(m.params);
        else if (typeof m.id === "number") pending.get(m.id)?.(m);
    });
    const call = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (r) => (r.error ? reject(Object.assign(new Error("refused"), r.error)) : resolve(r.result as T)));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    const settle = () => new Promise((r) => setTimeout(r, 30));
    return { ws, events, call, settle, epoch: hello.epoch };
}

type Sub = { id: string; seq: number; epoch: string; replayed: boolean; value?: unknown; events?: Ev[] };

test("an agent's bar: its value, then each change as data, in seq order; unsubscribe stops it", async () => {
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: "agent.worker.bar" });
    assert.equal(s.value, null, "no bar pushed yet");
    setAgentBar("worker", { v: 1, state: "idle" } as never);
    setAgentBar("worker", { v: 1, state: "busy" } as never);
    await c.settle();
    assert.equal(c.events.length, 2);
    assert.ok(c.events[0].seq < c.events[1].seq);
    assert.deepEqual((c.events[1].data as { bar: unknown }).bar, { v: 1, state: "busy" });
    assert.equal(c.events[1].subject, "agent.worker.bar");
    await c.call("bus.unsubscribe", { id: s.id });
    setAgentBar("worker", { v: 1, state: "idle" } as never);
    await c.settle();
    assert.equal(c.events.length, 2);
});

test("who may subscribe: another agent's bar and every agent's are a human's", async () => {
    const other = await open("other");
    await assert.rejects(other.call("bus.subscribe", { subject: "agent.worker.bar" }), (e: { code: number }) => e.code === 403);
    await assert.rejects(other.call("bus.subscribe", { subject: "agent.*.bar" }), (e: { code: number }) => e.code === 403);
    await assert.rejects(other.call("bus.subscribe", { subject: "user.worker.pings" }), (e: { code: number }) => e.code === 403);
    await assert.rejects(other.call("bus.subscribe", { subject: "nothing.here" }), (e: { code: number }) => e.code === 404);
    await assert.rejects(other.call("bus.subscribe", { subject: "ticket.*" }), (e: { code: number }) => e.code === 400);
    const boss = await open("boss");
    const all = await boss.call<Sub>("bus.subscribe", { subject: "agent.*.bar" });
    assert.ok((all.value as Record<string, unknown>).worker, "every bar, by agent");
    setAgentBar("other", { v: 1, state: "busy" } as never);
    await boss.settle();
    assert.ok(boss.events.some((e) => e.subject === "agent.other.bar"), "the concrete subject on each event");
});

test("a project's rows: the list's, and each change pushed is the row the list gives that subscriber", async () => {
    const t1 = ticket("one");
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", open: true });
    const list = (await getMethod("inbox.list")!.run(testCaller("worker"),
        { project: "p-subs", view: "turn", open: true })) as { rows: unknown[] };
    assert.deepEqual(s.value, list.rows);
    submitMessage({ project: "p-subs", kind: "comment_added", ticket_id: t1, parent_id: t1, body: "c", by_agent: "boss" });
    await c.settle();
    const up = c.events.at(-1)!.data as { op: string; row: { id: number } };
    assert.equal(up.op, "upsert");
    const one = (await getMethod("inbox.list")!.run(testCaller("worker"),
        { project: "p-subs", view: "turn", open: true, ids: String(t1) })) as { rows: unknown[] };
    assert.deepEqual(JSON.parse(JSON.stringify(up.row)), JSON.parse(JSON.stringify(one.rows[0])), "the pushed row is the list's row");
    submitMessage({ project: "p-subs", kind: "ticket_closed", ticket_id: t1, parent_id: t1, by_agent: "boss" });
    await c.settle();
    assert.deepEqual(c.events.at(-1)!.data, { op: "remove", id: t1, project: "p-subs" }, "a closed ticket leaves an open view");
});

test("#3163 — a ticket closed by an accepted resolution leaves an open view, and shows closed in the others", async () => {
    const t = ticket("resolved by accept");
    const proposal = submitMessage({ project: "p-subs", kind: "comment_added", ticket_id: t, parent_id: t, body: "done", decision_kind: "resolution", summary_until: "done", by_agent: "worker" } as never);
    const c = await open("boss");
    await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", open: true });
    const all = await open("boss");
    await all.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets" });
    await c.call("message.decide", { id: proposal.id, status: "accepted" });
    await c.settle();
    await all.settle();
    const mine = (e: Ev) => (e.data as { id?: number; row?: { id: number } }).id === t || (e.data as { row?: { id: number } }).row?.id === t;
    assert.deepEqual(c.events.filter(mine).at(-1)?.data, { op: "remove", id: t, project: "p-subs" }, "the open view drops it");
    const last = all.events.filter(mine).at(-1)?.data as { op: string; row: { closed: boolean } };
    assert.equal(last.op, "upsert");
    assert.equal(last.row.closed, true, "the full view has it closed");
});

test("a ticket moved to another project leaves the view it was in", async () => {
    const t2 = ticket("two");
    const c = await open("worker");
    await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", open: true });
    moveTicketTo(t2, "p-away", "boss");
    await c.settle();
    const gone = c.events.find((e) => (e.data as { op: string; id: number }).op === "remove" && (e.data as { id: number }).id === t2);
    assert.ok(gone, "removed from the view it was in");
    assert.equal(gone.subject, "project.p-subs.tickets");
});

test("a ticket's thread: its full read, then each message as data", async () => {
    const t3 = ticket("three");
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: `ticket.${t3}` });
    assert.equal((s.value as { ticket: { id: number } }).ticket.id, t3);
    const m = submitMessage({ project: "p-subs", kind: "comment_added", ticket_id: t3, parent_id: t3, body: "hello", by_agent: "boss" });
    await c.settle();
    const ev = c.events.find((e) => e.subject === `ticket.${t3}`)!;
    assert.equal((ev.data as { type: string }).type, "message_created");
    assert.equal((ev.data as { message: { id: number } }).message.id, m.id);
});

test("one's pings: pushed as they land; the listener goes with the last subscription", async () => {
    const t4 = ticket("four");
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: "user.worker.pings" });
    assert.equal(typeof (s.value as { unread: number }).unread, "number");
    // worker owns the project: a comment there pings it, the usual way.
    const m = submitMessage({ project: "p-subs", kind: "comment_added", ticket_id: t4, parent_id: t4, body: "ping", by_agent: "boss" });
    await c.settle();
    const ping = c.events.find((e) => e.subject === "user.worker.pings");
    assert.ok(ping, "the ping was pushed");
    assert.deepEqual([(ping.data as { ticket_id: number }).ticket_id, (ping.data as { comment_id: number }).comment_id], [t4, m.id]);
    const msg = (ping.data as { message: Record<string, unknown> }).message;
    assert.deepEqual([msg.id, msg.title, msg.by_agent, msg.kind, msg.project], [m.id, "four", "boss", "comment_added", "p-subs"], "the ping carries what it points at");
    const before = subscriptionCountForTests();
    c.ws.close();
    await c.settle();
    assert.ok(subscriptionCountForTests() < before, "a closed connection's subscriptions are gone");
});

test("since: what was missed is replayed while the daemon holds it; another epoch gets the value", async () => {
    const c = await open("worker");
    const first = await c.call<Sub>("bus.subscribe", { subject: "agent.worker.bar" });
    await c.call("bus.unsubscribe", { id: first.id });
    setAgentBar("worker", { v: 1, state: "missed-1" } as never);
    setAgentBar("worker", { v: 1, state: "missed-2" } as never);
    const back = await c.call<Sub>("bus.subscribe", { subject: "agent.worker.bar", since: { epoch: first.epoch, seq: first.seq } });
    assert.equal(back.replayed, true);
    assert.equal(back.value, undefined);
    assert.deepEqual(back.events!.map((e) => (e.data as { bar: { state: string } }).bar.state), ["missed-1", "missed-2"]);
    const stale = await c.call<Sub>("bus.subscribe", { subject: "agent.worker.bar", since: { epoch: "another-daemon", seq: 1 } });
    assert.equal(stale.replayed, false);
    assert.equal((stale.value as { bar: { state: string } }).bar.state, "missed-2");
    const view = await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", since: { epoch: first.epoch, seq: first.seq } });
    assert.equal(view.replayed, false, "a view is sent whole again");
});

test("subscribing needs a bus connection", () => {
    assert.throws(() => getMethod("bus.subscribe")!.run(testCaller("worker"), { subject: "agent.worker.bar" }), /bus connection/);
});

test("project.*.tickets: every project's rows by project, and a project created later is heard", async () => {
    ticket("five");
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: "project.*.tickets", open: true });
    assert.ok(Array.isArray((s.value as Record<string, unknown[]>)["p-subs"]), "rows keyed by project");
    createProject({ name: "p-later" });
    upsertSubscription("worker", "p-later", "owner");
    const t = submitMessage({ project: "p-later", kind: "ticket_created", title: "later", body: "b", by_agent: "boss" }).id;
    await c.settle();
    const up = c.events.find((e) => e.subject === "project.p-later.tickets");
    assert.ok(up, "the new project's ticket arrives");
    assert.equal((up.data as { row: { id: number } }).row.id, t);
});

test("a row that changes with time alone is pushed when it does, and only when it does", async () => {
    const t = ticket("six");
    const { setTicketClaim } = await import("../db.js");
    setTicketClaim(t, "worker");
    const c = await open("worker");
    const s = await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", open: true });
    const row = (s.value as { id: number; hot: boolean }[]).find((r) => r.id === t)!;
    assert.equal(row.hot, true, "just claimed: hot");
    const { sweepDeadlines } = await import("./methods/subjects.js");
    sweepDeadlines();
    await c.settle();
    assert.equal(c.events.length, 0, "nothing is due yet: nothing is pushed");
    // The claim ages past the hot window, as it would with time.
    const { getDb } = await import("../db/connection.js");
    const { sql } = await import("drizzle-orm");
    getDb().run(sql`UPDATE tickets SET claimed_at = ${new Date(Date.now() - 30 * 86_400_000).toISOString()} WHERE id = ${t}`);
    sweepDeadlines(Date.now() + 40 * 86_400_000);
    await c.settle();
    const cooled = c.events.find((e) => (e.data as { row?: { id: number } }).row?.id === t);
    assert.ok(cooled, "the row was rebuilt when its deadline passed");
    assert.equal((cooled.data as { row: { hot: boolean } }).row.hot, false);
});

test("an event that leaves a row as it was pushes nothing on the view", async () => {
    const t = ticket("seven");
    const c = await open("worker");
    await c.call<Sub>("bus.subscribe", { subject: "project.p-subs.tickets", open: true });
    const { broadcast } = await import("../ws.js");
    const { getMessage } = await import("../db.js");
    broadcast({ type: "message_edited", data: getMessage(t) });
    await c.settle();
    assert.equal(c.events.filter((e) => e.subject === "project.p-subs.tickets").length, 0);
});

test("#3070 an agent's state: each event is its whole consumer.list entry, only when it changed, null once deleted", async () => {
    upsertConsumer({ consumer_id: "watched", kind: "agent" });
    // #3133 — its counters computed first: a first read would compute them and push them after.
    (await import("../agent-counters.js")).refreshCounters("watched");
    const c = await open("boss");
    await c.call<Sub>("bus.subscribe", { subject: "agent.*.state" });
    const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");
    const { consumerEntryFor } = await import("./methods/consumer.js");
    presenceConnect("watched", "terminal");
    await c.settle();
    const mine = () => c.events.filter((e) => e.subject === "agent.watched.state");
    assert.equal(mine().length, 1);
    assert.deepEqual(mine()[0].data, JSON.parse(JSON.stringify(consumerEntryFor("watched"))), "the entry, under consumer.list's names");
    assert.equal((mine()[0].data as { present: boolean }).present, true);
    const { broadcast } = await import("../ws.js");
    broadcast({ type: "consumer_changed", data: { consumer_id: "watched", running: true } });
    await c.settle();
    assert.equal(mine().length, 1, "an event that changes nothing pushes nothing");
    presenceDisconnect("watched");
    const { deleteConsumer } = await import("../db.js");
    deleteConsumer("watched");
    broadcast({ type: "consumer_changed", data: { consumer_id: "watched", deleted: true } });
    await c.settle();
    assert.equal(mine().at(-1)!.data, null, "a deleted consumer is null");
});

test("#3070 a state subscription resumed with since gets the events it missed, entries whole", async () => {
    upsertConsumer({ consumer_id: "resumed", kind: "agent" });
    const c = await open("boss");
    const first = await c.call<Sub>("bus.subscribe", { subject: "agent.*.state" });
    await c.call("bus.unsubscribe", { id: first.id });
    const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");
    presenceConnect("resumed", "terminal");
    const back = await c.call<Sub>("bus.subscribe", { subject: "agent.*.state", since: { epoch: first.epoch, seq: first.seq } });
    assert.equal(back.replayed, true);
    const missed = back.events!.filter((e) => e.subject === "agent.resumed.state");
    assert.equal(missed.length, 1, "the missed change, replayed");
    assert.equal((missed[0].data as { present: boolean }).present, true);
    presenceDisconnect("resumed");
});

test("#3089 a pings subscription resumed with since still gets its pings, and letting it go balances the source", async () => {
    const t = ticket("pinged later");
    const c = await open("worker");
    const first = await c.call<Sub>("bus.subscribe", { subject: "user.worker.pings" });
    await c.call("bus.unsubscribe", { id: first.id });
    const back = await c.call<Sub>("bus.subscribe", { subject: "user.worker.pings", since: { epoch: first.epoch, seq: first.seq } });
    assert.equal(back.replayed, true, "the path that used to lose the source");
    const m = submitMessage({ project: "p-subs", kind: "comment_added", ticket_id: t, parent_id: t, body: "after resume", by_agent: "boss" });
    await c.settle();
    const ping = c.events.find((e) => e.subject === "user.worker.pings" && (e.data as { comment_id?: number }).comment_id === m.id);
    assert.ok(ping, "pushed to the resumed subscription");
    const { pingSourceCountForTests } = await import("./methods/subjects.js");
    assert.equal(pingSourceCountForTests("worker"), 1, "one source, held by the one subscription");
    await c.call("bus.unsubscribe", { id: back.id });
    assert.equal(pingSourceCountForTests("worker"), null, "every subscription let go: the source is unwired");
    const two = [await c.call<Sub>("bus.subscribe", { subject: "user.worker.pings" }), await c.call<Sub>("bus.subscribe", { subject: "user.worker.pings", since: { epoch: first.epoch, seq: first.seq } })];
    assert.equal(pingSourceCountForTests("worker"), 2, "two subscriptions share one source");
    await c.call("bus.unsubscribe", { id: two[0].id });
    assert.equal(pingSourceCountForTests("worker"), 1);
    await c.call("bus.unsubscribe", { id: two[1].id });
    assert.equal(pingSourceCountForTests("worker"), null);
});
