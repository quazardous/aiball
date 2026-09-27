/**
 * #3068 — nodes, pairing and signal keys as methods: every one a human's,
 * over the bus and over the routes that now serve them; a key's token comes
 * back once, when it is minted.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3068-nodes-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-nodes" });
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

function http(method: string, path: string, body?: unknown, token = BOSS): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
            let b = "";
            res.on("data", (d) => { b += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : null }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

const code = (c: string) => (e: { code: string }) => e.code === c;
const status = (n: number) => (e: { status: number }) => e.status === n;

test("every node and key surface is a human's", async () => {
    const w = await as(WORKER);
    for (const [m, p] of [
        ["node.list", {}], ["node.pairing", {}], ["node.set_pairing", { verb: "open" }], ["node.enrollments", {}],
        ["node.decide_enrollment", { id: "x", verdict: "approve" }], ["node.revoke", { node_id: "x" }],
        ["signal_key.list", {}], ["signal_key.create", { label: "l" }], ["signal_key.update", { key_id: "x", note: "n" }],
        ["signal_key.revoke", { key_id: "x" }], ["project.signals", { name: "p-nodes" }],
    ] as const) {
        await assert.rejects(w.call(m, p), code("MODERATOR_ONLY"), m);
    }
    assert.equal((await http("GET", "/api/nodes", undefined, WORKER)).status, 403, "the route holds the same gate");
});

test("the pairing window opens and shuts; a decision on a request that is not pending is a 409", async () => {
    const boss = await as(BOSS);
    assert.equal((await boss.call<{ open: boolean }>("node.set_pairing", { verb: "open", minutes: 5 })).open, true);
    assert.deepEqual(await boss.call("node.pairing", {}), (await http("GET", "/api/nodes/pairing")).json);
    assert.equal((await boss.call<{ open: boolean }>("node.set_pairing", { verb: "close" })).open, false);
    await assert.rejects(boss.call("node.set_pairing", { verb: "ajar" }), status(400));
    assert.ok(Array.isArray(await boss.call("node.list", {})));
    assert.deepEqual(await boss.call("node.enrollments", {}), []);
    await assert.rejects(boss.call("node.decide_enrollment", { id: "nope", verdict: "approve" }), status(409));
    await assert.rejects(boss.call("node.revoke", { node_id: "nope" }), status(404));
});

test("a signal key: minted with its token once, listed without it, changed, revoked", async () => {
    const boss = await as(BOSS);
    const minted = await http("POST", "/api/signal-keys", { label: "ci", note: "the CI" });
    assert.equal(minted.status, 201, JSON.stringify(minted.json));
    const { key, token } = minted.json as { key: { key_id: string }; token: string };
    assert.ok(token);
    const listed = await boss.call<Array<{ key_id: string }>>("signal_key.list", {});
    assert.ok(listed.some((k) => k.key_id === key.key_id));
    assert.ok(!JSON.stringify(listed).includes(token), "a listing never carries the token");
    assert.equal((await boss.call<{ note: string }>("signal_key.update", { key_id: key.key_id, note: "changed" })).note, "changed");
    assert.deepEqual(await boss.call("signal_key.revoke", { key_id: key.key_id }), { key_id: key.key_id, revoked: true });
    await assert.rejects(boss.call("signal_key.revoke", { key_id: key.key_id }), status(404));
    assert.deepEqual(await boss.call("project.signals", { name: "p-nodes" }), (await http("GET", "/api/projects/p-nodes/signals")).json);
});
