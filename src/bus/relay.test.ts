/**
 * #3071 — the bus through a proxy node: a real hub and a real node in one
 * process. The node relays each local connection to the hub's `/bus`: the
 * caller is the consumer the node names, relayed; subscriptions work through
 * it; the hub's hello is the one the client gets; either side closing closes
 * the other; strict mode refuses a caller without its own token.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-3071-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
// #3284 — the loops a node lists are its machine's: an empty root of the test's own.
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");

const { createApp } = await import("../app.js");
const { attachBus, busConnectionCountForTests } = await import("./server.js");
const { attachBusRelay } = await import("./relay.js");
const { upsertConsumer } = await import("../db.js");
const { issueToken } = await import("../db/tokens.js");
const { setAgentBar } = await import("../agent-bar-store.js");
const { BusClient } = await import("../bus-client.js");
const { BUS_EPOCH } = await import("./subscriptions.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const NODE = issueToken({ kind: "node", label: "node-b" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "w" }).token;

const hub = createServer(createApp());
const hubBus = attachBus(hub);
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;

async function node(cfg: { strict?: boolean; trusted?: boolean } = {}) {
    const sock = join(home, `node-${Math.random().toString(36).slice(2, 8)}.sock`);
    const srv = createServer((_q, r) => { r.statusCode = 404; r.end(); });
    attachBusRelay(srv, { url: hubUrl, token: NODE, strict: cfg.strict, nodeLabel: "node-b" }, new Map(), { trusted: cfg.trusted });
    await new Promise<void>((r) => srv.listen(sock, () => r()));
    return { sock, srv };
}

const nodeA = await node();
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const s of [hub, nodeA.srv]) { s.closeAllConnections(); s.close(); }
    rmSync(home, { recursive: true, force: true });
});

async function through(consumer: string, sock = nodeA.sock, extra: Record<string, string> = {}) {
    const c = await BusClient.connect({ socket: sock, consumer, headers: extra });
    clients.push(c);
    return c;
}

test("through the node, the caller is the consumer it names, relayed, and the hello is the hub's", async () => {
    const c = await through("worker");
    assert.equal(c.hello.epoch, BUS_EPOCH, "the hub's hello, not the node's");
    assert.deepEqual(c.hello.relayed, true);
    const who = await c.call<{ consumer: string; relayed: boolean }>("bus.whoami");
    assert.deepEqual([who.consumer, who.relayed], ["worker", true]);
});

test("a caller with its own token keeps it: the hub sees that consumer, not the node's word", async () => {
    const c = await through("boss", nodeA.sock, { authorization: `Bearer ${WORKER}` });
    const who = await c.call<{ consumer: string; relayed: boolean }>("bus.whoami");
    assert.deepEqual([who.consumer, who.relayed], ["worker", false], "its own token, end to end");
});

test("a loop control through the node is refused, whoever it names", async () => {
    const c = await through("boss");
    await assert.rejects(c.call("consumer.stop_loop", { consumer_id: "worker" }), (e: { code: string; message: string }) => e.code === "FORBIDDEN" && /proxy node/.test(e.message));
});

// #3284 — what acts on a machine, a node answers for its own.
const local = await node({ trusted: true });
after(() => { local.srv.closeAllConnections(); local.srv.close(); });

test("a machine method through the node is answered by the node, not refused by the hub", async () => {
    const c = await through("boss", local.sock);
    assert.deepEqual(await c.call("loop.list"), [], "the node's own loops: none on this test machine");
    assert.ok(Array.isArray(await c.call("session.list")));
    const info = await c.call<{ version: string }>("daemon.info");
    assert.equal(typeof info.version, "string");
    // The board still goes to the hub.
    assert.deepEqual((await c.call<{ consumer: string; relayed: boolean }>("bus.whoami")).relayed, true);
});

test("the node answers as the caller the hub named: an agent is still refused a human's gesture", async () => {
    const c = await through("worker", local.sock);
    await assert.rejects(c.call("loop.list"), (e: { code: string }) => e.code === "MODERATOR_ONLY");
});

test("a batch that mixes the machine's methods and the board's is refused, call by call", async () => {
    const ws = new WebSocket(`ws+unix:${local.sock}:/bus`, { headers: { "x-aiball-consumer": "boss" } });
    const frames: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
        ws.on("message", (d) => {
            const m = JSON.parse(String(d));
            if (m.method === "bus.hello") {
                ws.send(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "loop.list" }, { jsonrpc: "2.0", id: 2, method: "bus.whoami" }]));
                return;
            }
            frames.push(m);
            resolve();
        });
        ws.on("error", reject);
    });
    ws.close();
    const answers = frames[0] as { id: number; error?: { data: { code: string } } }[];
    assert.deepEqual(answers.map((a) => [a.id, a.error?.data.code]), [[1, "BAD_REQUEST"], [2, "BAD_REQUEST"]]);
});

test("the hub itself refuses a machine method to a relayed caller: it would act on the hub's machine", async () => {
    const c = await BusClient.connect({ url: hubUrl, token: NODE, headers: { "x-aiball-consumer": "boss" } });
    clients.push(c);
    await assert.rejects(c.call("loop.list"), (e: { code: string; message: string }) => e.code === "FORBIDDEN" && /machine that answers/.test(e.message));
});

test("a subscription through the node gets its events", async () => {
    const c = await through("boss");
    const ws = (c as unknown as { ws: { on(e: string, f: (d: unknown) => void): void } }).ws;
    const events: { subject: string }[] = [];
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.method === "bus.event") events.push(m.params); });
    await c.call("bus.subscribe", { subject: "agent.worker.bar" });
    setAgentBar("worker", { v: 1, state: "busy" } as never);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.filter((e) => e.subject === "agent.worker.bar").length, 1);
});

test("closing the local connection closes the upstream one, and the hub closing closes the local one", async () => {
    const before = busConnectionCountForTests();
    const c = await through("worker");
    assert.equal(busConnectionCountForTests(), before + 1);
    c.close();
    const deadline = Date.now() + 3000;
    while (busConnectionCountForTests() > before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(busConnectionCountForTests(), before, "the upstream connection went with it");
    const d = await through("worker");
    const closed = d.closed();
    // The hub drops its side, as when it restarts.
    for (const ws of hubBus.clients) ws.terminate();
    assert.ok(typeof await closed === "number", "the local connection closed when the hub's did");
});

test("strict mode: a caller without its own token is refused at the node", async () => {
    const strict = await node({ strict: true });
    try {
        await assert.rejects(BusClient.connect({ socket: strict.sock, consumer: "worker" }), (e: { status: number }) => e.status === 401);
        const ok = await BusClient.connect({ socket: strict.sock, consumer: "boss", headers: { authorization: `Bearer ${WORKER}` } });
        clients.push(ok);
        assert.equal((await ok.call<{ consumer: string }>("bus.whoami")).consumer, "worker");
    } finally {
        strict.srv.closeAllConnections();
        strict.srv.close();
    }
});

test("the client's platform reaches the hub: a ticket filed through the node gets its tag", async () => {
    const { createProject } = await import("../db/projects.js");
    createProject({ name: "p-3071" });
    const c = await through("boss", nodeA.sock, { "x-aiball-platform": "linux" });
    const t = await c.call<{ id: number; tags: { name: string }[] }>("message.post", { project: "p-3071", kind: "ticket_created", title: "via node", body: "b" });
    const { listMessageTags } = await import("../db/tags.js");
    assert.ok(listMessageTags(t.id).some((x) => x.name === "os:linux"), "tagged from the relayed platform");
});

// #3293 — a loop control for a loop of the node's own machine: the node sends
// it on the loop's socket; a loop elsewhere is still relayed, and refused.
test("stop, prompt and restart a loop of the node's machine, through its socket", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { listenEvents } = await import("../claude-loop/ipc-events.js");
    const { loopSockPath } = await import("../claude-loop/state.js");
    const sd = join(process.env.CLAUDE_LOOP_STATE_ROOT!, "cl-b-1");
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "plate.json"), JSON.stringify({ name: "cl-b-1", cwd: "/w/b", agent: "b-agent", created_at: new Date().toISOString() }));
    const got: Record<string, unknown>[] = [];
    let busy = true;
    const loop = listenEvents(loopSockPath(sd), (ev, ctx) => {
        // As the kernel answers: the request's id rides back on the reply.
        if (ev.kind === "queryLoopState") ctx.reply({ kind: "queryLoopStateReply", data: { paneBusy: busy, paneReady: !busy, __req: (ev.data as { __req?: string }).__req } });
        else if (ev.kind === "proxyEvent") got.push(ev.data as Record<string, unknown>);
    });
    try {
        const c = await through("boss", local.sock);
        const stop = await c.call<{ delivered: boolean }>("consumer.stop_loop", { consumer_id: "b-agent" });
        assert.equal(stop.delivered, true);
        await c.call("consumer.prompt", { consumer_id: "b-agent", text: "hello" });
        await assert.rejects(c.call("consumer.restart_claude", { name: "b-agent" }), (e: { code: string }) => e.code === "NOT_IDLE", "busy: refused unless when_idle");
        await c.call("consumer.restart_claude", { name: "b-agent", when_idle: true });
        busy = false;
        await c.call("consumer.restart_claude", { name: "b-agent" });
        const deadline = Date.now() + 2000;
        while (got.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(got.map((e) => [e.event, e.action, e.text ?? e.when_idle ?? null]), [
            ["control", "kill", null], ["control", "prompt", "hello"], ["control", "restart_claude", true], ["control", "restart_claude", null],
        ]);
        // A loop the node does not run is still the hub's, and refused relayed.
        await assert.rejects(c.call("consumer.stop_loop", { consumer_id: "worker" }), (e: { code: string }) => e.code === "FORBIDDEN");
    } finally {
        loop.close();
    }
});
