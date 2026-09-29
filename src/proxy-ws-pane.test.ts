// #505 phase 2, #3128 — end-to-end: a node-relayed consumer (last_seen_via='node')
// and a simulated node answering the `pane.*` frames: `agent.<id>.screen` and
// `agent.pane_keys` on the bus route through the node's reverse connection
// instead of answering unavailable.
//
// We simulate the node = a WS client that connects to /ws/proxy-node with a
// node token, intercepts the incoming `pane.stream.open` / `pane.keys`, and
// answers with `pane.frame` / `pane.ack`. No tmux needed on the test side: we
// shortcut the node-side pane handler (proxy.ts) by handling the frames by
// hand in the test.
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
const { ensureConsumer, setConsumerState, touchLastSeen, upsertConsumer } = await import("./db.js");

// Setup : a "graphite-loop" consumer + a node-token. The IP matching between the
// node and the consumer happens at runtime (the server bumps last_seen_ip on the
// fake-node's WS connection from loopback), so we take the real ip
// post-connect to reconcile the consumer.
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

// Connects the fake-node + attaches the pane handler BEFORE open resolves,
// so the server's `hello` is not lost in the window between open and the
// attach (the ws lib does not buffer events without a listener).
/** A call of `agent` relayed by the node, as its loop's calls are. */
async function relayedCall(agent: string): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/api/uploads/none`, { headers: { authorization: `Bearer ${NODE_TOKEN}`, "x-aiball-consumer": agent } });
}

function startFakeNode(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
        attachPaneHandler(ws);
        ws.on("open", async () => {
            // #3349 — the agent's calls come through the node's token: that is
            // how the daemon knows which node to reach it through (no address).
            await relayedCall("graphite-loop");
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
                // Emit 2 synthetic frames right away
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
                /* no-op for the test */
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

// #3349 — an agent never seen through a node: said so, never a node guessed.
test("agent.pane_keys: an agent not seen through a node since the start is told so, not given another node", async () => {
    // Relayed before this daemon started (its row says so), not seen since.
    ensureConsumer("never-relayed");
    setConsumerState("never-relayed", "idle", false, undefined, "/fake/cwd/never");
    touchLastSeen("never-relayed", "node", null);
    const node = await startFakeNode();
    try {
        await assert.rejects(operator.call("agent.pane_keys", { agent: "never-relayed", keys: "x" }),
            (e: { message: string }) => /has not called this daemon through a proxy node/.test(e.message));
    } finally {
        node.close();
    }
});

after(() => {
    operator.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});
