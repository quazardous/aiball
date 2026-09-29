// #505 phase 2, #3128 — end-to-end: a node-relayed consumer (last_seen_via='node')
// and a simulated node answering the `pane.*` frames: `agent.<id>.screen` and
// `agent.pane_keys` on the bus route through the node's reverse connection
// instead of answering unavailable.
//
// On simule le node = un client WS qui se connecte sur /ws/proxy-node avec un
// token node, intercepte les `pane.stream.open` / `pane.keys` qui arrivent, et
// répond avec `pane.frame` / `pane.ack`. Pas besoin de tmux côté test : on
// shortcut le pane handler du node-side (proxy.ts) en gérant manuellement les
// frames côté test.
import { test, after } from "node:test";
import { until } from "./tests/lib.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-505p2-"));

process.env.AIBALL_SOCK = ""; // #3241 — never the live daemon's socket, even run directly

const { createApp } = await import("./app.js");
const { attachBus } = await import("./bus/server.js");
const { BusClient } = await import("./bus-client.js");
const { attachProxyWs, PROXY_WS_PATH, listConnectedNodeIds } = await import("./proxy-ws.js");
const { issueToken } = await import("./db/tokens.js");
const { listNodes } = await import("./db/nodes.js");
const { ensureConsumer, touchLastSeen, setConsumerState, upsertConsumer } = await import("./db.js");

// Setup : un consumer "graphite-loop" + un node-token. Le matching IP entre le
// node et le consumer se fait au runtime (le serveur bumpe last_seen_ip à la
// connexion WS du fake-node depuis le loopback), donc on prend l'ip réelle
// post-connect pour reconcilier le consumer.
ensureConsumer("graphite-loop");
setConsumerState("graphite-loop", "idle", false, undefined, "/fake/cwd/graphite");
const NODE_TOKEN = issueToken({ kind: "node", label: "fake-node" }).token;
upsertConsumer({ consumer_id: "operator", kind: "human" });

const server = createServer(createApp());
attachProxyWs(server);
server.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
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

// The operator: a human on the local socket, as the web UI's bus is.
const sockPath = join(process.env.AIBALL_HOME!, "bus.sock");
const uds = createServer(createApp());
const wss = attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));
const operator = await BusClient.connect({ socket: sockPath, consumer: "operator" });
const heard = new Map<string, Array<{ kind: string; text?: string; error?: string }>>();
operator.onNotification((method, params) => {
    const p = params as { subscription: string; data: { kind: string; text?: string; error?: string } };
    if (method !== "bus.event") return;
    if (!heard.has(p.subscription)) heard.set(p.subscription, []);
    heard.get(p.subscription)!.push(p.data);
});
test("agent.pane_keys, node-relayed: routed over the node's connection, acknowledged", async () => {
    const node = await startFakeNode();
    const r = await operator.call<{ sent: number }>("agent.pane_keys", { agent: "graphite-loop", keys: "echo hello\n" });
    assert.equal(r.sent, 11);
    node.close();
});

test("agent.pane_keys, node-relayed: 502 with the reason when the node is not connected", async () => {
    await until("the node gone", () => listConnectedNodeIds().length === 0);
    await assert.rejects(operator.call("agent.pane_keys", { agent: "graphite-loop", keys: "echo hello\n" }),
        (e: { status: number; message: string }) => e.status === 502 && /no proxy node|no node matches|not connected/.test(e.message));
});

test("agent.<id>.screen, node-relayed: the node's frames, and pane.stream.close when let go", async () => {
    const node = await startFakeNode();
    const closed: string[] = [];
    node.on("message", (data) => {
        const f = JSON.parse(data.toString()) as { kind?: string; request_id?: string };
        if (f.kind === "pane.stream.close" && f.request_id) closed.push(f.request_id);
    });
    const s = await operator.call<{ id: string; value: unknown }>("bus.subscribe", { subject: "agent.graphite-loop.screen" });
    assert.deepEqual(s.value, { source: "node" });
    await until("two frames", () => (heard.get(s.id) ?? []).filter((e) => e.kind === "frame").length >= 2);
    assert.match(heard.get(s.id)![0]!.text ?? "", /FAKE PANE FRAME #1/);
    await operator.call("bus.unsubscribe", { id: s.id });
    await until("the node told to stop", () => closed.length === 1);
    node.close();
});

test("agent.<id>.screen, node-relayed: unavailable, with the reason, when the node is not connected", async () => {
    await until("the node gone", () => listConnectedNodeIds().length === 0);
    const s = await operator.call<{ id: string }>("bus.subscribe", { subject: "agent.graphite-loop.screen" });
    await until("the unavailable event", () => (heard.get(s.id) ?? []).length > 0);
    const e = heard.get(s.id)![0]!;
    assert.equal(e.kind, "unavailable");
    assert.match(e.error ?? "", /no proxy node|no node matches|not connected/);
});

after(() => {
    operator.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});
