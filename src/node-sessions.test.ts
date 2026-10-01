// #3468 — a proxy node tells its hub the agents' sessions its own host holds
// (`node_sessions_push`), and the hub puts them in the agents' entries
// (`agent.<id>.state`), checked: the node's machine, its loops only, its
// token's projects; forgotten when the node goes.
import { test, after } from "node:test";
import { sleep } from "./tests/lib.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-3468-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("./app.js");
const { attachProxyWs, PROXY_WS_PATH } = await import("./proxy-ws.js");
const { issueToken } = await import("./db/tokens.js");
const { upsertConsumer, setConsumerState } = await import("./db/consumers.js");
const { consumerEntryFor } = await import("./bus/methods/consumer.js");
const { presenceConnect, presenceDisconnect } = await import("./live-presence.js");
const { buildSessionsPushFrame } = await import("./proxy.js");
const { attachFor } = await import("./agent-bar.js");

const OPEN = issueToken({ kind: "node", label: "n-open" }).token;
const NARROW = issueToken({ kind: "node", label: "n-narrow", projects: JSON.stringify(["p-ok"]) }).token;
for (const [a, p] of [["a-one", "p-ok"], ["a-two", "p-ok"], ["a-other", "p-no"], ["a-hub", "p-ok"]] as const) {
    upsertConsumer({ consumer_id: a, kind: "agent" });
    setConsumerState(a, "idle", undefined, undefined, "/w", p);
}

const server = createServer(createApp());
attachProxyWs(server);
server.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const WS_URL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${PROXY_WS_PATH}`;
after(() => {
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function openNode(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${token}` } });
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
    });
}

/** Each test's node connection, closed whatever the test did. */
async function withNode(token: string, run: (ws: WebSocket) => Promise<void>): Promise<void> {
    const ws = await openNode(token);
    try { await run(ws); } finally { ws.terminate(); }
}

const control = (agent: string) => join(home, "hosts", agent, "control.sock");
const view = (agent: string, machine = "node:somewhere-else") => ({
    agent, name: null, host: "daemon", machine, pid: 42, cwd: "/w", running: true, clients: 1, interactive: 1,
    attach: { socket: join(dirname(control(agent)), "attach.sock") },
});
const sessionOf = (agent: string) => (consumerEntryFor(agent) as { session: { machine: string; attach?: { socket: string } } | null } | null)?.session ?? null;

test("a session the node pushes is in its agent's entry, with the node's machine whatever the frame said", async () => {
    presenceConnect("a-one", "terminal", "node:n-open");
    await withNode(OPEN, async (ws) => {
        ws.send(JSON.stringify(buildSessionsPushFrame([view("a-one"), { agent: null }])));
        await sleep(80);
        const s = sessionOf("a-one");
        assert.ok(s, "the agent's entry carries the node's session");
        assert.equal(s!.machine, "node:n-open", "the machine is the node's, not the frame's");
        // One source for where to attach: the bar the kernel pushes says the same.
        assert.deepEqual(attachFor({ hostControl: control("a-one") }), { socket: s!.attach!.socket });
    });
    await sleep(80);
    assert.equal(sessionOf("a-one"), null, "the node gone, its session is gone");
    presenceDisconnect("a-one");
});

test("a session for an agent whose loop is not live through that node is not shown", async () => {
    // Its loop runs elsewhere (or not at all): a node cannot put a session on it.
    presenceConnect("a-two", "terminal", "hub");
    await withNode(OPEN, async (ws) => {
        ws.send(JSON.stringify(buildSessionsPushFrame([view("a-two")])));
        await sleep(80);
        assert.equal(sessionOf("a-two"), null);
    });
    presenceDisconnect("a-two");
});

test("a node token restricted to projects speaks only for their agents", async () => {
    presenceConnect("a-one", "terminal", "node:n-narrow");
    presenceConnect("a-other", "terminal", "node:n-narrow");
    await withNode(NARROW, async (ws) => {
        ws.send(JSON.stringify(buildSessionsPushFrame([view("a-one"), view("a-other")])));
        await sleep(80);
        assert.ok(sessionOf("a-one"), "an agent of its project");
        assert.equal(sessionOf("a-other"), null, "an agent of another project is refused");
    });
    await sleep(80);
    presenceDisconnect("a-one");
    presenceDisconnect("a-other");
});

test("a later push replaces the earlier one whole: a session no longer said is gone", async () => {
    presenceConnect("a-one", "terminal", "node:n-open");
    await withNode(OPEN, async (ws) => {
        ws.send(JSON.stringify(buildSessionsPushFrame([view("a-one")])));
        await sleep(80);
        assert.ok(sessionOf("a-one"));
        ws.send(JSON.stringify(buildSessionsPushFrame([])));
        await sleep(80);
        assert.equal(sessionOf("a-one"), null);
    });
    presenceDisconnect("a-one");
});
