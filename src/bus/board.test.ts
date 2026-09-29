/**
 * #3068 — the web's settings and housekeeping, as methods: strategy, a
 * project's standing prompt, purges, info, the config manager, tag admin,
 * `me`, and the moderator's ticket gestures. A bus connection and a direct
 * call with the same token give the same answers; the human-only gestures stay so.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3068-board-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { asToken } = await import("../tests/bus-call.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-board" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;
const BOSS = issueToken({ kind: "auth", consumer_id: "boss", label: "b" }).token;

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

async function as(token: string) {
    const c = await BusClient.connect({ url: `http://127.0.0.1:${port}`, token });
    clients.push(c);
    return c;
}

/** The same method called directly with the token, off any connection. */
function direct(method: string, params: Record<string, unknown> = {}, token = BOSS): Promise<{ status: number; json: unknown }> {
    return asToken(token, method, params);
}

const status = (n: number) => (e: { status: number }) => e.status === n;
const code = (c: string) => (e: { code: string }) => e.code === c;

test("strategy, a project's strategy and standing prompt: a bus connection and a direct call agree", async () => {
    const boss = await as(BOSS);
    const set = await boss.call<{ strategy: string }>("strategy.set", { strategy: "manual" });
    assert.equal(set.strategy, "manual");
    assert.deepEqual(await boss.call("strategy.get", {}), (await direct("strategy.get")).json);
    await assert.rejects(boss.call("strategy.set", { strategy: "whatever" }), status(400));

    assert.equal((await boss.call<{ strategy: string | null }>("project.set_strategy", { project: "p-board", strategy: "auto" })).strategy, "auto");
    assert.equal((await boss.call<{ strategy: string | null }>("project.set_strategy", { project: "p-board", strategy: null })).strategy, null, "null clears it");
    assert.deepEqual(await boss.call("project.strategy", { project: "p-board" }), (await direct("project.strategy", { project: "p-board" })).json);

    const sp = await boss.call<{ standing_prompt: string }>("project.set_standing_prompt", { project: "p-board", standing_prompt: "focus" });
    assert.equal(sp.standing_prompt, "focus");
    const t = submitMessage({ project: "p-board", kind: "ticket_created", title: "t", body: "b", by_agent: "worker" });
    const focus = await direct("project.set_standing_prompt", { project: "p-board", focus_tickets: `${t.id}`, focus_until: null });
    assert.equal(focus.status, 200, JSON.stringify(focus.json));
    assert.equal((focus.json as { standing_prompt: string }).standing_prompt, "focus", "the prompt stays when only the focus is sent");
    await assert.rejects(boss.call("project.set_standing_prompt", { project: "p-board", focus_tickets: "999999" }), status(400));
});

test("info, stats, token series and purges answer; purging a project with nothing old purges nothing", async () => {
    const boss = await as(BOSS);
    const info = await boss.call<{ version: string; counts: unknown }>("board.info", {});
    assert.ok(info.version && info.counts);
    assert.ok(await boss.call("project.stats_rich", { name: "p-board" }));
    assert.ok(Array.isArray((await boss.call<{ series: unknown[] }>("token_usage.timeseries", { days: 7 })).series));
    const purged = await boss.call<{ purged_tickets: number; older_than_days: number }>("project.purge", { name: "p-board" });
    assert.deepEqual([purged.purged_tickets, purged.older_than_days], [0, 365]);
    assert.equal((await boss.call<{ purged_tickets: number }>("board.purge", { older_than_days: 30 })).purged_tickets, 0);
});

test("the config manager: an unknown key is 404, to set it and to clear it", async () => {
    const boss = await as(BOSS);
    const all = await boss.call<{ project: string | null; config: unknown[] }>("config.managed", {});
    assert.equal(all.project, null);
    assert.deepEqual(all, (await direct("config.managed")).json);
    await assert.rejects(boss.call("config.set", { key: "no.such.key", value: 1 }), status(404));
    assert.equal((await direct("config.clear", { key: "no.such.key" })).status, 404);
});

test("tag admin: create, update, delete; a duplicate is refused", async () => {
    const boss = await as(BOSS);
    const t = await boss.call<{ id: number; name: string }>("tag.create", { name: "adm-x", color: "#123456" });
    assert.equal(t.name, "adm-x");
    await assert.rejects(boss.call("tag.create", { name: "adm-x" }), status(400));
    const viaDirect = await direct("tag.create", { name: "adm-y" });
    assert.equal(viaDirect.status, 200);
    assert.equal((await boss.call<{ note: string }>("tag.update", { id: t.id, note: "n" })).note, "n");
    assert.equal((await direct("tag.delete", { id: t.id })).status, 200);
    await assert.rejects(boss.call("tag.delete", { id: t.id }), status(404));
});

test("me, mark unread; the moderator's gestures stay a human's", async () => {
    const boss = await as(BOSS);
    const w = await as(WORKER);
    assert.equal((await boss.call<{ consumer_id: string }>("consumer.me", {})).consumer_id, "boss");
    assert.equal((await w.call<{ consumer_id: string }>("consumer.me", {})).consumer_id, "worker");

    const t = submitMessage({ project: "p-board", kind: "ticket_created", title: "gestures", body: "b", by_agent: "worker" });
    const unread = await boss.call<{ ticket_id: number; ticket: unknown }>("ticket.mark_unread", { id: t.id });
    assert.equal(unread.ticket_id, t.id);
    await assert.rejects(boss.call("ticket.mark_unread", { id: 999_999 }), code("TICKET_NOT_FOUND"));

    assert.ok(Array.isArray((await boss.call<{ subscriptions: unknown[] }>("ticket.subscribers", { id: t.id })).subscriptions));
    await assert.rejects(w.call("ticket.subscribers", { id: t.id }), code("MODERATOR_ONLY"));
    assert.equal((await direct("ticket.subscribers", { id: t.id }, WORKER)).status, 403);

    await assert.rejects(w.call("ticket.step", { id: t.id }), code("MODERATOR_ONLY"));
    await assert.rejects(boss.call("ticket.step", { id: t.id }), status(409), "no comment yet");
});

test("#3068 — the upload cap and the read-pings purge, as methods", async () => {
    const boss = await as(BOSS);
    const w = await as(WORKER);
    const set = await boss.call<{ bytes: number; hard_cap: number }>("upload.set_max_bytes", { bytes: 2_000_000 });
    assert.equal(set.bytes, 2_000_000);
    assert.equal((await w.call<{ bytes: number }>("upload.max_bytes", {})).bytes, 2_000_000);
    await assert.rejects(boss.call("upload.set_max_bytes", { bytes: -1 }), status(400));

    assert.equal(typeof (await boss.call<{ deleted: number }>("ping.purge_seen_closed", {})).deleted, "number");
    await assert.rejects(w.call("ping.purge_seen_closed", {}), code("MODERATOR_ONLY"), "an agent from afar may not");
});
