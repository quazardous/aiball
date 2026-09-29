/**
 * #3067 — the read state as methods: a bus connection and a direct call give
 * the same answer; `consumer_id` left out means the caller; marking
 * another consumer's backlog read, or deleting, stays a human's gesture.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-read-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { asToken } = await import("../tests/bus-call.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
createProject({ name: "p-read" });
for (const c of ["worker", "other"]) upsertSubscription(c, "p-read", "owner");
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

// Something unread for worker and other: a ticket boss files, then a comment on it.
const t = submitMessage({ project: "p-read", kind: "ticket_created", title: "to read", body: "b", by_agent: "boss" });
submitMessage({ project: "p-read", kind: "comment_added", ticket_id: t.id, parent_id: t.id, body: "c", by_agent: "boss" });

test("unread and pings: a bus connection and a direct call give the same answer", async () => {
    const c = await worker();
    const viaBus = await c.call("unread.list", { consumer_id: "worker", project: "p-read" });
    const viaDirect = await direct("unread.list", { consumer_id: "worker", project: "p-read" });
    assert.deepEqual(viaBus, viaDirect.json);
    assert.deepEqual(await c.call("ping.count", { consumer_id: "worker" }), (await direct("ping.count", { consumer_id: "worker" })).json);
    assert.deepEqual(await c.call("consumer.micro_status", { consumer_id: "worker", project: "p-read" }), (await direct("consumer.micro_status", { consumer_id: "worker", project: "p-read" })).json);
});

test("consumer_id left out: the caller's own", async () => {
    const c = await worker();
    const mine = await c.call<{ consumer_id: string; count: number }>("unread.count", { project: "p-read" });
    assert.equal(mine.consumer_id, "worker");
    assert.deepEqual(mine, await c.call("unread.count", { consumer_id: "worker", project: "p-read" }));
});

test("an agent marking another consumer's backlog read, or deleting, is refused; its own is not", async () => {
    const c = await worker();
    await assert.rejects(c.call("unread.mark_read", { consumer_id: "other", project: "p-read", all: true }), (e: { code: string }) => e.code === "MODERATOR_ONLY");
    await assert.rejects(c.call("unread.mark_read", { project: "p-read", all: true, delete: true }), (e: { code: string }) => e.code === "MODERATOR_ONLY");
    const over = await direct("unread.mark_read", { consumer_id: "other", project: "p-read", all: true });
    assert.equal(over.status, 403, "a direct call refuses it the same way");
    const own = await c.call<{ consumer_id: string }>("unread.mark_read", { project: "p-read", all: true });
    assert.equal(own.consumer_id, "worker");
    assert.equal((await c.call<{ count: number }>("unread.count", { project: "p-read" })).count, 0);
    assert.ok((await c.call<{ count: number }>("unread.count", { consumer_id: "other", project: "p-read" })).count > 0, "other's untouched");
});
