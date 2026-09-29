/**
 * #3067 — finding and following tickets as methods: a bus connection and a
 * direct call give the same answer; a yes/no filter given as a boolean reads
 * as the "1" of a query string; subscriptions left without `consumer_id` are
 * the caller's; the delete answers nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-lookup-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { asToken } = await import("../tests/bus-call.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-look" });
upsertSubscription("worker", "p-look", "owner");
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;

const tcp = createServer(createApp());
const wss = attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as { port: number }).port;
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    tcp.closeAllConnections();
    tcp.close();
    rmSync(home, { recursive: true, force: true });
});

async function worker() {
    const c = await BusClient.connect({ url: `http://127.0.0.1:${port}`, token: WORKER });
    clients.push(c);
    return c;
}

/** The same method called directly, as the holder of the worker's token. */
function direct(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: unknown }> {
    return asToken(WORKER, method, params);
}

const open = submitMessage({ project: "p-look", kind: "ticket_created", title: "zebra crossing", body: "b", by_agent: "boss" });
const closed = submitMessage({ project: "p-look", kind: "ticket_created", title: "zebra closed", body: "b", by_agent: "boss" });
submitMessage({ project: "p-look", kind: "ticket_closed", ticket_id: closed.id, parent_id: closed.id, by_agent: "boss" } as never);

test("the ticket list: a bus connection and a direct call agree, and a boolean filter reads as the query's 1", async () => {
    const c = await worker();
    const viaDirect = await direct("ticket.list", { project: "p-look", open: "1" });
    assert.deepEqual(await c.call("ticket.list", { project: "p-look", open: "1" }), viaDirect.json);
    assert.deepEqual(await c.call("ticket.list", { project: "p-look", open: true }), viaDirect.json, "open: true is open=1");
    const ids = (viaDirect.json as { id: number }[]).map((t) => t.id);
    assert.ok(ids.includes(open.id));
    assert.ok(!ids.includes(closed.id), "the open filter applied");
});

test("search and the decisions lenses: a bus connection and a direct call agree", async () => {
    const c = await worker();
    assert.deepEqual(await c.call("message.search", { q: "zebra", project: "p-look" }), (await direct("message.search", { q: "zebra", project: "p-look" })).json);
    assert.deepEqual(await c.call("message.search", { q: "  " }), [], "an empty query finds nothing");
    assert.deepEqual(await c.call("decision.mine"), (await direct("decision.mine")).json);
    assert.deepEqual(await c.call("decision.plans_to_execute"), (await direct("decision.plans_to_execute")).json);
});

test("subscriptions: the caller's by default, and a direct call answers them too", async () => {
    const c = await worker();
    createProject({ name: "p-follow" });
    const sub = await c.call<{ consumer_id: string; project: string }>("project.subscribe", { project: "p-follow", role: "follower" });
    assert.deepEqual([sub.consumer_id, sub.project], ["worker", "p-follow"]);
    const del = await direct("project.unsubscribe", { consumer_id: "worker", project: "p-follow" });
    assert.equal(del.status, 200);
    assert.equal(del.json, null, "no result");
    const t = await c.call<{ consumer_id: string; muted: boolean }>("ticket.subscribe", { ticket_id: open.id });
    assert.deepEqual([t.consumer_id, t.muted], ["worker", false]);
    assert.equal((await c.call<{ state: string | null }>("ticket.subscription", { ticket_id: open.id })).state, "followed");
    await assert.rejects(c.call("ticket.subscribe", { ticket_id: 987_654 }), (e: { code: string }) => e.code === "TICKET_NOT_FOUND");
    const posted = await direct("ticket.subscribe", { consumer_id: "worker", ticket_id: open.id, muted: true });
    assert.equal(posted.status, 200);
});
