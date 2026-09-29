/**
 * #3067 — projects as methods, over the bus: created, listed and read, and
 * the refusals (a name taken, a rename onto an existing name or from a
 * missing one).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-project-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
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

test("create, list and read a project over the bus", async () => {
    const c = await worker();
    const made = await c.call<{ name: string }>("project.create", { name: "p-one", description: "first" });
    assert.equal(made.name, "p-one");
    assert.equal((await c.call<{ name: string }>("project.create", { name: "p-two" })).name, "p-two");
    const listed = await c.call<string[]>("project.list");
    assert.ok(listed.includes("p-one") && listed.includes("p-two"), JSON.stringify(listed));
    const detailed = await c.call<{ name: string }[]>("project.list", { detailed: true, consumer_id: "worker" });
    assert.ok(["p-one", "p-two"].every((n) => detailed.some((p) => p.name === n)), JSON.stringify(detailed.map((p) => p.name)));
    const one = await c.call<{ name: string }[]>("project.list", { detailed: true, consumer_id: "worker", project: "p-one" });
    assert.deepEqual(one.map((p) => p.name), ["p-one"], "narrowed to one project");
    const stats = await c.call("project.stats", { name: "p-one" });
    assert.equal(typeof stats, "object", "the stats are answered");
    assert.ok(stats);
    await c.call("project.standing_prompt", { project: "p-one" });
    await c.call("consumer.presence", { project: "p-one" });
});

test("the refusals: a name taken, a rename onto one, a rename from nothing", async () => {
    const c = await worker();
    await assert.rejects(c.call("project.create", { name: "p-one" }), (e: { status: number }) => e.status === 409);
    await assert.rejects(c.call("project.create", { name: "has space" }), (e: { status: number }) => e.status === 400);
    await assert.rejects(c.call("project.rename", { name: "p-one", new_name: "p-two" }), (e: { status: number }) => e.status === 409);
    await assert.rejects(c.call("project.rename", { name: "p-none", new_name: "p-three" }), (e: { status: number }) => e.status === 404);
    const renamed = await c.call<{ old_name: string; new_name: string }>("project.rename", { name: "p-two", new_name: "p-three" });
    assert.deepEqual([renamed.old_name, renamed.new_name], ["p-two", "p-three"]);
    const del = await c.call<{ project: string; ok: boolean }>("project.delete", { name: "p-three" });
    assert.deepEqual([del.project, del.ok], ["p-three", true]);
});
