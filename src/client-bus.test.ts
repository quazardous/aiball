/**
 * #3067 — the shared client calls the core over the bus. What its callers (the
 * MCP server, the CLI, claude-loop) rely on must not change with the transport:
 * the same answers as HTTP, a refusal with its `status` and body, a daemon
 * restart survived, a call cut in flight never replayed (it may have run) but
 * spooled when it is a post, and a short-lived process that exits without
 * closing the connection.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const home = mkdtempSync(join(tmpdir(), "aiball-3067-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("./app.js");
const { attachBus } = await import("./bus/server.js");
const { upsertConsumer } = await import("./db.js");
const { createProject } = await import("./db/projects.js");
const { AiballClient } = await import("./client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "p-3067" });

const sock = join(home, "d.sock");
const daemon = createServer(createApp());
daemon.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
const wss = attachBus(daemon, { trusted: true });
await new Promise<void>((r) => daemon.listen(sock, () => r()));

const fakes: { close(): void }[] = [];
after(() => {
    for (const f of fakes) f.close();
    // Closing an HTTP server leaves its upgraded (websocket) connections open.
    for (const ws of wss.clients) ws.terminate();
    daemon.closeAllConnections();
    daemon.close();
    rmSync(home, { recursive: true, force: true });
});

function client(agentId: string, socketPath = sock) {
    return new AiballClient({ socketPath, agentId, defaultProject: "p-3067", home: join(home, agentId) });
}

async function http(method: string, path: string, consumer: string): Promise<{ status: number; body: unknown }> {
    const { request } = await import("node:http");
    return new Promise((resolve, reject) => {
        request({ socketPath: sock, path, method, headers: { "x-aiball-consumer": consumer } }, (res) => {
            let b = "";
            res.on("data", (d) => { b += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
        }).on("error", reject).end();
    });
}

test("a ticket filed and read over the bus: the same answer as HTTP", async () => {
    const boss = client("boss");
    const t = await boss.postMessage({ project: "p-3067", kind: "ticket_created", title: "over the bus", body: "b" }) as { id: number };
    assert.equal(typeof t.id, "number");
    const viaBus = await boss.getTicket(t.id, { summary: false });
    const viaHttp = await http("GET", `/api/tickets/${t.id}?full=1`, "boss");
    assert.deepEqual(viaBus, viaHttp.body);
});

test("a refusal keeps the shape HTTP gave it: status, and the body with its code", async () => {
    const worker = client("worker");
    const t = await client("boss").postMessage({ project: "p-3067", kind: "ticket_created", title: "for a refusal", body: "b" }) as { id: number };
    const overHttp = await http("POST", `/api/messages/${t.id}/approve`, "worker");
    assert.ok(overHttp.status >= 400 && overHttp.status < 500, JSON.stringify(overHttp));
    await assert.rejects(worker.approve(t.id), (e: Error & { status?: number }) => {
        assert.equal(e.status, overHttp.status, "the status HTTP gives the same call");
        assert.ok(e.message.includes(JSON.stringify((overHttp.body as { code: string }).code)), e.message);
        return true;
    });
    await assert.rejects(worker.getTicket(999_999), (e: Error & { status?: number }) => e.status === 404);
});

test("the daemon dropping the connection (a restart): the next call opens a new one", async () => {
    const boss = client("boss");
    await boss.listConsumers();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    const list = await boss.listConsumers();
    assert.ok(list.some((c) => c.consumer_id === "worker"));
});

/** A bus that says hello, then does what `onCall` says with each call. */
async function fakeBus(onCall: (ws: import("ws").WebSocket, frame: { id: number }) => void) {
    const path = join(home, `fake-${Math.random().toString(36).slice(2, 8)}.sock`);
    const srv = createServer();
    const fake = new WebSocketServer({ server: srv, path: "/bus" });
    const seen: unknown[] = [];
    fake.on("connection", (ws) => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "bus.hello", params: { version: 1, epoch: "e", consumer: "boss", kind: "human", relayed: false } }));
        ws.on("message", (d) => { const f = JSON.parse(String(d)); seen.push(f); onCall(ws, f); });
    });
    await new Promise<void>((r) => srv.listen(path, () => r()));
    fakes.push({ close: () => { for (const ws of fake.clients) ws.terminate(); fake.close(); srv.closeAllConnections(); srv.close(); } });
    return { path, seen };
}

test("a call cut while in flight is not replayed: it may have run", async () => {
    const fake = await fakeBus((ws) => ws.terminate());
    await assert.rejects(client("boss", fake.path).getMessage(1), (e: Error & { code?: string; status?: number }) => {
        assert.equal(e.code, "EBUSCLOSED");
        assert.equal(e.status, undefined, "no status: postMessage spools it");
        return true;
    });
    assert.equal(fake.seen.length, 1, "sent once, never again");
});

test("a post cut in flight goes to the spool, as a request cut after its bytes left does", async () => {
    const fake = await fakeBus((ws) => ws.terminate());
    const c = client("boss", fake.path);
    const r = await c.postMessage({ project: "p-3067", kind: "ticket_created", title: "spooled", body: "b" }) as { queued?: boolean };
    assert.equal(r.queued, true);
    assert.equal(readdirSync(c.spoolDir).length, 1);
});

test("a short-lived process exits without closing the connection", async () => {
    const script = `
        const { AiballClient } = await import(${JSON.stringify(join(import.meta.dirname, "client.ts"))});
        const c = new AiballClient({ socketPath: ${JSON.stringify(sock)}, agentId: "boss" });
        const list = await c.listConsumers();
        console.log("listed", list.length);
    `;
    const started = Date.now();
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            env: { ...process.env, AIBALL_HOME: join(home, "child") },
            stdio: ["ignore", "pipe", "inherit"],
        });
        let stdout = "";
        child.stdout.on("data", (d) => { stdout += d; });
        const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("exit", (code) => { clearTimeout(kill); resolve({ code, stdout }); });
    });
    assert.match(out.stdout, /listed \d+/);
    assert.equal(out.code, 0, "exited on its own, not killed");
    assert.ok(Date.now() - started < 15_000);
});
