/**
 * #3000 — `/ws` is authenticated like `/api`: over TCP it needs a valid token
 * (header or `?token=`); on the local socket it trusts the same user, as `/api`
 * does there. `broadcast` reaches the clients of both, and a client too far
 * behind is cut instead of buffered without end.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const home = mkdtempSync(join(tmpdir(), "aiball-3000-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { issueToken } = await import("./db/tokens.js");
const { ensureConsumer } = await import("./db.js");
const { attachWs, broadcast, wsServersForTests, WS_MAX_BUFFERED } = await import("./ws.js");

ensureConsumer("ws-reader");
const TOKEN = issueToken({ kind: "agent", consumer_id: "ws-reader", label: "3000" }).token;

const tcp = createServer((_q, r) => { r.statusCode = 404; r.end(); });
attachWs(tcp, "/ws");
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as AddressInfo).port;

const sockPath = join(home, "test.sock");
const uds = createServer((_q, r) => { r.statusCode = 404; r.end(); });
attachWs(uds, "/ws", { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));

after(() => {
    // A failing test can leave a client open, and close() would wait for it
    // forever: cut every connection first.
    for (const w of wsServersForTests()) for (const c of w.clients) c.terminate();
    tcp.closeAllConnections();
    uds.closeAllConnections();
    tcp.close();
    uds.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Open a client; resolve with it once the hello arrived, or with the HTTP status it was refused with. */
function open(url: string, opts: Record<string, unknown> = {}): Promise<{ ws?: WebSocket; status?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, opts);
        ws.once("unexpected-response", (_req, res) => { resolve({ status: res.statusCode }); ws.terminate(); });
        ws.once("message", () => resolve({ ws }));
        ws.once("error", () => { /* surfaced through unexpected-response */ });
    });
}
const nextMessage = (ws: WebSocket) => new Promise<unknown>((r) => ws.once("message", (m) => r(JSON.parse(String(m)))));

test("over TCP, no token or a wrong one is refused with 401", async () => {
    assert.equal((await open(`ws://127.0.0.1:${port}/ws`)).status, 401);
    assert.equal((await open(`ws://127.0.0.1:${port}/ws?token=nope`)).status, 401);
});

test("over TCP, a valid token opens it, in the query or in the header", async () => {
    const q = await open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    assert.ok(q.ws, "query token");
    const h = await open(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.ok(h.ws, "header token");
    q.ws!.close();
    h.ws!.close();
});

test("on the local socket, no token is needed, and broadcast reaches both kinds of client", async () => {
    const local = await open(`ws+unix://${sockPath}:/ws`);
    assert.ok(local.ws, "the local socket trusts the same user");
    const remote = await open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const got = Promise.all([nextMessage(local.ws!), nextMessage(remote.ws!)]);
    broadcast({ type: "tag_changed", data: { n: 1 } });
    assert.deepEqual(await got, [{ type: "tag_changed", data: { n: 1 } }, { type: "tag_changed", data: { n: 1 } }]);
    local.ws!.close();
    remote.ws!.close();
});

test("a client too far behind is cut, not fed", async () => {
    const slow = await open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    // Its server side: the one client of the TCP server still open.
    await new Promise((r) => setTimeout(r, 50));
    const serverSide = [...wsServersForTests()].flatMap((s) => [...s.clients]).find((c) => c.readyState === WebSocket.OPEN);
    assert.ok(serverSide);
    Object.defineProperty(serverSide, "bufferedAmount", { get: () => WS_MAX_BUFFERED + 1 });
    const closed = new Promise<void>((r) => slow.ws!.once("close", () => r()));
    broadcast({ type: "tag_changed", data: { n: 2 } });
    await closed;
});
