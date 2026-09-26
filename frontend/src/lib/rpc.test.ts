// #3068 — the web UI's bus client against a real daemon app, with the
// WebSocket a browser has (Node's own): a token in the query, calls queued
// until the hello, refusals as RpcError, a lost connection opened again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3068-rpc-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../../../src/app.js");
const { attachBus } = await import("../../../src/bus/server.js");
const { upsertConsumer } = await import("../../../src/db.js");
const { createProject } = await import("../../../src/db/projects.js");
const { issueToken } = await import("../../../src/db/tokens.js");
const { Rpc, RpcError } = await import("./rpc");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "p-rpc" });
const TOKEN = issueToken({ kind: "auth", consumer_id: "boss", label: "web" }).token;

let tcp: Server;
let wss: ReturnType<typeof attachBus>;
let port = 0;
async function up(): Promise<void> {
    tcp = createServer(createApp());
    wss = attachBus(tcp);
    await new Promise<void>((r) => tcp.listen(port, "127.0.0.1", () => r()));
    port = (tcp.address() as { port: number }).port;
}
async function down(): Promise<void> {
    // An upgraded socket is not one of the server's HTTP connections.
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    tcp.closeAllConnections();
    await new Promise<void>((r) => tcp.close(() => r()));
}
await up();
const rpcs: InstanceType<typeof Rpc>[] = [];
after(async () => {
    for (const r of rpcs) r.close();
    await down();
    rmSync(home, { recursive: true, force: true });
});

function client(token: string | null, authValid = async () => true, onUnauthorized = () => {}) {
    const r = new Rpc({ url: () => `ws://127.0.0.1:${port}/bus`, token: () => token, authValid, onUnauthorized });
    rpcs.push(r);
    return r;
}

test("calls made before the hello are sent after it; a refusal is an RpcError with its code", async () => {
    const r = client(TOKEN);
    const [projects, stats] = await Promise.all([
        r.call<Array<string>>("project.list"),
        r.call<{ project: string }>("project.stats", { name: "p-rpc" }),
    ]);
    assert.ok(projects.includes("p-rpc"));
    assert.ok(stats);
    await assert.rejects(r.call("ticket.get", { id: 999_999 }), (e: unknown) =>
        e instanceof RpcError && e.code === "TICKET_NOT_FOUND" && e.status === 404 && e.message.startsWith("ticket.get → 404"));
});

test("a daemon that went away: a call made while it is down waits, and goes once it is back", async () => {
    const r = client(TOKEN);
    await r.call("project.list");
    await down();
    // The socket closing is seen before the next call; give it a moment.
    await new Promise((res) => setTimeout(res, 50));
    const later = r.call<string[]>("project.list");
    await new Promise((res) => setTimeout(res, 300));
    await up();
    assert.ok((await later).includes("p-rpc"), "queued while down, answered once back");
});

test("a token that no longer counts: queued calls fail with 401 and the page is told", async () => {
    let told = 0;
    const r = client("not-a-token", async () => false, () => { told++; });
    await assert.rejects(r.call("project.list"), (e: unknown) => e instanceof RpcError && e.status === 401);
    assert.equal(told, 1);
});
