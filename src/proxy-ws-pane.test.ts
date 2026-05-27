// #505 phase 2 — end-to-end : un consumer node-relayé (last_seen_via='node')
// + un node simulé qui répond aux frames `pane.*` doit voir le /pane/stream et
// /pane/keys de papy router les requêtes via la WS au lieu de dégrader en
// `event: unavailable` / 501.
//
// On simule le node = un client WS qui se connecte sur /ws/proxy-node avec un
// token node, intercepte les `pane.stream.open` / `pane.keys` qui arrivent, et
// répond avec `pane.frame` / `pane.ack`. Pas besoin de tmux côté test : on
// shortcut le pane handler du node-side (proxy.ts) en gérant manuellement les
// frames côté test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-505p2-"));

const { createApp } = await import("./app.js");
const { attachProxyWs, PROXY_WS_PATH } = await import("./proxy-ws.js");
const { issueToken } = await import("./db/tokens.js");
const { listNodes } = await import("./db/nodes.js");
const { ensureConsumer, touchLastSeen, setConsumerState } = await import("./db.js");

// Setup : un consumer "graphite-loop" + un node-token. Le matching IP entre le
// node et le consumer se fait au runtime (le serveur bumpe last_seen_ip à la
// connexion WS du fake-node depuis le loopback), donc on prend l'ip réelle
// post-connect pour reconcilier le consumer.
ensureConsumer("graphite-loop");
setConsumerState("graphite-loop", "idle", false, undefined, "/fake/cwd/graphite");
const NODE_TOKEN = issueToken({ kind: "node", label: "fake-node" }).token;
ensureConsumer("operator");
const OPERATOR_TOKEN = issueToken({ kind: "agent", consumer_id: "operator", label: "ops" }).token;

const server = createServer(createApp());
attachProxyWs(server);
server.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;
const WS_URL = `ws://127.0.0.1:${port}${PROXY_WS_PATH}`;

// Connecte le fake-node + attache le handler pane AVANT que open ne resolve,
// pour ne pas perdre le `hello` du serveur dans la fenêtre entre open et le
// attach (le ws lib ne buffer pas les events sans listener).
function startFakeNode(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
        attachPaneHandler(ws);
        ws.on("open", () => {
            // Reconcilie l'IP : le serveur a bumpé tokens.last_seen_ip à
            // l'IP réelle du peer (loopback). On bump le consumer avec la même.
            const nodeRow = listNodes().find((n) => n.label === "fake-node");
            if (nodeRow?.last_seen_ip) {
                touchLastSeen("graphite-loop", "node", nodeRow.last_seen_ip);
            }
            resolve(ws);
        });
        ws.on("error", reject);
    });
}

function attachPaneHandler(ws: WebSocket): void {
    ws.on("message", (data) => {
        let frame: { kind?: string; request_id?: string; cwd?: string; keys?: string };
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (!frame.request_id) return;
        switch (frame.kind) {
            case "pane.stream.open":
                // Émet 2 frames synthétiques tout de suite
                ws.send(JSON.stringify({
                    kind: "pane.frame",
                    request_id: frame.request_id,
                    text: "FAKE PANE FRAME #1",
                    target: "fake.0",
                    truncated: false,
                    captured_at: new Date().toISOString(),
                }));
                ws.send(JSON.stringify({
                    kind: "pane.frame",
                    request_id: frame.request_id,
                    text: "FAKE PANE FRAME #2",
                    target: "fake.0",
                    truncated: false,
                    captured_at: new Date().toISOString(),
                }));
                break;
            case "pane.stream.close":
                /* no-op pour le test */
                break;
            case "pane.keys":
                ws.send(JSON.stringify({
                    kind: "pane.ack",
                    request_id: frame.request_id,
                    ok: true,
                }));
                break;
        }
    });
}

test("POST /pane/keys node-relayé : route via WS → 204 sur ack OK", async () => {
    const node = await startFakeNode();
    const r = await fetch(`${BASE}/api/agents/graphite-loop/pane/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ keys: "echo hello\n" }),
    });
    assert.equal(r.status, 204);
    node.close();
});

test("POST /pane/keys node-relayé : 503 si node non connecté", async () => {
    // Pas de fake-node up → getProxyNodeSocket renvoie null
    const r = await fetch(`${BASE}/api/agents/graphite-loop/pane/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ keys: "echo hello\n" }),
    });
    assert.equal(r.status, 503);
    const body = await r.json() as { error: string };
    // #505 diagnostic enrichi
    assert.match(body.error, /No proxy node|No node row|is registered/);
});

test("GET /pane/stream node-relayé : SSE relaie les pane.frame venant du node", async () => {
    const node = await startFakeNode();

    const r = await fetch(`${BASE}/api/agents/graphite-loop/pane/stream`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const collected: string[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value?: Uint8Array; done: boolean }>((res) => setTimeout(() => res({ done: true }), 500)),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value);
        // Frames SSE = `data: ...\n\n`. On collecte les 2 attendues + on break.
        const matches = buf.matchAll(/data: (.+)\n\n/g);
        for (const m of matches) collected.push(m[1]);
        if (collected.length >= 2) break;
    }
    assert.ok(collected.length >= 2, `got ${collected.length} frames, expected >= 2`);
    const f1 = JSON.parse(collected[0]) as { text?: string };
    assert.match(f1.text ?? "", /FAKE PANE FRAME #1/);
    await reader.cancel(); // ferme le SSE côté client → server reçoit req.close
    node.close();
});

test("GET /pane/stream node-relayé : event 'unavailable' si node non connecté", async () => {
    const r = await fetch(`${BASE}/api/agents/graphite-loop/pane/stream`, {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /event: unavailable/);
    assert.match(text, /No proxy node|No node row|is registered/);
});

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});
