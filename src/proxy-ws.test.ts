// #505 — canal inverse WS proxy node ↔ upstream. Phase 1 = handshake + liveness
// via la WS persistante (remplace l'ancien HTTP heartbeat #502). Le serveur
// monte `/ws/proxy-node` avec auth bearer node-token ; chaque frame bumpe
// `tokens.last_used_at` — c'est ce timestamp qui alimente la pastille up/down.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-505-"));

const { createApp } = await import("./app.js");
const { attachProxyWs, getProxyNodeSocket, PROXY_WS_PATH } = await import("./proxy-ws.js");
const { issueToken } = await import("./db/tokens.js");
const { listNodes } = await import("./db/nodes.js");
const { nodeId: computeNodeId } = await import("./db/nodes.js");
const { ensureConsumer } = await import("./db.js");

ensureConsumer("test-agent");
const NODE_TOKEN = issueToken({ kind: "node", label: "test-node-ws" }).token;
const AGENT_TOKEN = issueToken({ kind: "agent", consumer_id: "test-agent", label: "agent" }).token;

const server = createServer(createApp());
attachProxyWs(server);
server.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const WS_URL = `ws://127.0.0.1:${port}${PROXY_WS_PATH}`;

function openWs(token: string | null): Promise<{ ok: boolean; status?: number; ws?: WebSocket; firstFrame?: string }> {
    return new Promise((resolve) => {
        const opts = token ? { headers: { authorization: `Bearer ${token}` } } : {};
        const ws = new WebSocket(WS_URL, opts);
        let settled = false;
        // Capture la première message dès maintenant — sinon le `hello` que
        // le serveur envoie immédiatement à l'upgrade peut arriver AVANT que
        // le test ait eu le temps d'attacher son propre listener.
        let firstFrame: string | undefined;
        let firstResolve: ((v: string) => void) | null = null;
        const firstFramePromise = new Promise<string>((res) => { firstResolve = res; });
        ws.on("message", (data) => {
            const str = data.toString();
            if (firstFrame === undefined) {
                firstFrame = str;
                firstResolve?.(str);
            }
        });
        ws.on("unexpected-response", (_req, res) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* */ }
            resolve({ ok: false, status: res.statusCode });
        });
        ws.on("open", async () => {
            if (settled) return;
            settled = true;
            const frame = await Promise.race([
                firstFramePromise,
                new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no first frame")), 2000)),
            ]).catch(() => undefined);
            resolve({ ok: true, ws, firstFrame: frame });
        });
        ws.on("error", () => {
            if (settled) return;
            settled = true;
            resolve({ ok: false });
        });
    });
}

test("WS /ws/proxy-node : sans token → 401", async () => {
    const r = await openWs(null);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
});

test("WS /ws/proxy-node : token agent (mauvais kind) → 403", async () => {
    const r = await openWs(AGENT_TOKEN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
});

test("WS /ws/proxy-node : node token → handshake + frame `hello` + last_used_at bumpé", async () => {
    const before = listNodes().find((n) => n.label === "test-node-ws")?.last_used_at;
    const r = await openWs(NODE_TOKEN);
    assert.equal(r.ok, true);
    assert.ok(r.ws);
    assert.ok(r.firstFrame, "première frame reçue");
    const hello = JSON.parse(r.firstFrame!);
    assert.equal(hello.kind, "hello");
    assert.equal(hello.node_id, computeNodeId(NODE_TOKEN));
    // listNodes doit avoir last_used_at remis à neuf
    const after = listNodes().find((n) => n.label === "test-node-ws")?.last_used_at;
    assert.ok(after, "last_used_at peuplé après handshake");
    if (before) assert.ok(after! >= before, "last_used_at avancé");
    // Et on doit être indexable côté serveur via le node_id
    const sock = getProxyNodeSocket(computeNodeId(NODE_TOKEN));
    assert.ok(sock, "le serveur garde le socket dans son registry");
    r.ws!.close();
});

test("WS /ws/proxy-node : message du node bumpe last_used_at", async () => {
    const r = await openWs(NODE_TOKEN);
    assert.equal(r.ok, true);
    const tsBefore = listNodes().find((n) => n.label === "test-node-ws")?.last_used_at;
    await new Promise<void>((res) => setTimeout(res, 12)); // tick d'horloge
    r.ws!.send(JSON.stringify({ kind: "hello", label: "renamed-via-ws", client_ts: Date.now() }));
    // Laisse au serveur le temps de traiter le on("message")
    await new Promise<void>((res) => setTimeout(res, 50));
    const tsAfter = listNodes().find((n) => n.label === "test-node-ws")?.last_used_at;
    assert.ok(tsAfter, "last_used_at toujours là");
    if (tsBefore) assert.ok(tsAfter! >= tsBefore, "last_used_at re-bumpé sur frame du node");
    r.ws!.close();
});

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});
