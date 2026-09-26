/**
 * #3063 — the bus, phase 1: one connection per client, authenticated once by
 * the same function as HTTP; calls and batches straight into the method table;
 * who may call what, declared per method; a revoked token closes its
 * connections.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { z } from "zod";

const home = mkdtempSync(join(tmpdir(), "aiball-3063-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { issueToken, deleteToken } = await import("../db/tokens.js");
const { ensureConsumer, upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");
const { createApp } = await import("../app.js");
const { attachBus, sweepConnections, busConnectionCountForTests, BUS_CLOSE } = await import("./server.js");
const { defineMethod, Refusal, undefineMethodForTests } = await import("./methods.js");
const { MAX_BATCH } = await import("./rpc.js");
const { BusClient, BusError } = await import("../bus-client.js");
const { ERROR_CODES } = await import("../domain.js");

ensureConsumer("agent-a");
ensureConsumer("agent-b");
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "human", kind: "human" });
const AGENT = issueToken({ kind: "agent", consumer_id: "agent-a", label: "3063" }).token;
const HUMAN = issueToken({ kind: "auth", consumer_id: "boss", label: "3063" }).token;
const NODE = issueToken({ kind: "node", label: "node-3063" }).token;
const KEY = issueToken({ kind: "signal", label: "ci", scopes: JSON.stringify(["signals"]) }).token;

// Methods for these tests only, so that phase 1 is proven on its own rules.
const TEST_METHODS = ["test.humans", "test.local", "test.signal", "test.refuse", "test.crash", "test.slow", "test.store", "test.read"];
let stored: unknown = null;
defineMethod({ name: "test.humans", who: ["human"], params: z.object({}), run: () => "ok" });
defineMethod({ name: "test.local", who: ["human"], relayed: false, params: z.object({}), run: () => "ok" });
defineMethod({ name: "test.signal", who: ["key"], scope: "signals", params: z.object({}), run: (c) => c.signal_source });
defineMethod({
    name: "test.refuse",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => { throw new Refusal(409, "held by someone else", ERROR_CODES.TICKET_HELD, { holder: "x" }); },
});
defineMethod({ name: "test.crash", who: ["human", "agent"], params: z.object({}), run: () => { throw new Error("secret detail"); } });
defineMethod({
    name: "test.slow",
    who: ["human", "agent"],
    params: z.object({ ms: z.number() }),
    run: async ({}, p) => { await new Promise((r) => setTimeout(r, p.ms)); return "slow"; },
});
defineMethod({ name: "test.store", who: ["human", "agent"], params: z.object({ v: z.unknown() }), run: (_c, p) => { stored = p.v; return null; } });
defineMethod({ name: "test.read", who: ["human", "agent"], params: z.object({}), run: () => stored });

const app = createApp();
const tcp = createServer(app);
const tcpBus = attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}`;

const sockPath = join(home, "test.sock");
const uds = createServer(app);
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));

const clients: Awaited<ReturnType<typeof BusClient.connect>>[] = [];
async function connect(opts: Parameters<typeof BusClient.connect>[0]) {
    const c = await BusClient.connect(opts);
    clients.push(c);
    return c;
}

after(() => {
    for (const c of clients) c.close();
    for (const n of TEST_METHODS) undefineMethodForTests(n);
    tcp.closeAllConnections();
    uds.closeAllConnections();
    tcp.close();
    uds.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function refused(p: Promise<unknown>): Promise<import("../bus-client.js").BusError> {
    try {
        await p;
    } catch (e) {
        assert.ok(e instanceof BusError, `a BusError, got ${e}`);
        return e;
    }
    assert.fail("expected a refusal");
}

// --- Identity: once, at the opening, as HTTP decides it ---

test("over TCP, no token or a wrong one refuses the opening, with aiball's code", async () => {
    const none = await refused(connect({ url }));
    assert.deepEqual([none.status, none.code], [401, ERROR_CODES.AUTH_REQUIRED]);
    const wrong = await refused(connect({ url, token: "nope" }));
    assert.deepEqual([wrong.status, wrong.code], [401, ERROR_CODES.TOKEN_INVALID]);
});

test("the identity the bus settles is the one HTTP settles, for every kind of caller", async () => {
    const cases: { name: string; bus: Parameters<typeof BusClient.connect>[0]; http: { socket?: boolean; headers: Record<string, string> }; want: string }[] = [
        { name: "local, anonymous", bus: { socket: sockPath }, http: { socket: true, headers: {} }, want: "human" },
        { name: "local, named", bus: { socket: sockPath, consumer: "agent-b" }, http: { socket: true, headers: { "x-aiball-consumer": "agent-b" } }, want: "agent-b" },
        { name: "agent token", bus: { url, token: AGENT }, http: { headers: { authorization: `Bearer ${AGENT}` } }, want: "agent-a" },
        {
            name: "agent token claiming another name",
            bus: { url, token: AGENT, consumer: "agent-b" },
            http: { headers: { authorization: `Bearer ${AGENT}`, "x-aiball-consumer": "agent-b" } },
            want: "agent-a",
        },
        {
            name: "human token viewing as an agent",
            bus: { url, token: HUMAN, consumer: "agent-b" },
            http: { headers: { authorization: `Bearer ${HUMAN}`, "x-aiball-consumer": "agent-b" } },
            want: "agent-b",
        },
        {
            name: "node relaying an agent",
            bus: { url, token: NODE, consumer: "agent-b" },
            http: { headers: { authorization: `Bearer ${NODE}`, "x-aiball-consumer": "agent-b" } },
            want: "agent-b",
        },
    ];
    for (const k of cases) {
        const c = await connect(k.bus);
        const who = await c.call<{ consumer: string }>("bus.whoami");
        const httpMe = await httpGet("/api/me", k.http.headers, k.http.socket);
        assert.equal(who.consumer, k.want, `${k.name}: bus`);
        assert.equal((httpMe as { consumer_id: string }).consumer_id, k.want, `${k.name}: http`);
        c.close();
    }
});

test("the hello says who the connection runs as, and its kind", async () => {
    assert.deepEqual((await connect({ url, token: HUMAN })).hello, { version: 1, consumer: "boss", kind: "human", relayed: false });
    assert.deepEqual((await connect({ url, token: NODE, consumer: "agent-b" })).hello, { version: 1, consumer: "agent-b", kind: "agent", relayed: true });
    assert.deepEqual((await connect({ socket: sockPath, consumer: "agent-a" })).hello, { version: 1, consumer: "agent-a", kind: "agent", relayed: false });
});

// --- Who may call what: declared per method ---

test("a method open to humans refuses an agent, with the code a route would give", async () => {
    assert.equal(await (await connect({ url, token: HUMAN })).call("test.humans"), "ok");
    const agent = await refused((await connect({ url, token: AGENT })).call("test.humans"));
    assert.deepEqual([agent.status, agent.code, agent.rpcCode], [403, ERROR_CODES.FORBIDDEN, 403]);
});

test("a node relaying a human is that human, except where nodes may not reach", async () => {
    const node = await connect({ url, token: NODE, consumer: "boss" });
    assert.equal(await node.call("test.humans"), "ok", "as over HTTP: the relayed identity");
    const local = await refused(node.call("test.local"));
    assert.equal(local.code, ERROR_CODES.FORBIDDEN);
    assert.match(local.message, /proxy node/);
    assert.equal(await (await connect({ url, token: HUMAN })).call("test.local"), "ok");
});

test("an API key reaches only the methods open to keys, with the scope they need", async () => {
    const k = await connect({ url, token: KEY });
    assert.equal(await k.call("test.signal"), "ci");
    assert.equal((await refused(k.call("bus.whoami"))).code, ERROR_CODES.FORBIDDEN);
    const bare = issueToken({ kind: "signal", label: "no-scope", scopes: JSON.stringify(["tickets:create"]) }).token;
    const b = await connect({ url, token: bare });
    assert.equal((await refused(b.call("test.signal"))).code, ERROR_CODES.KEY_SCOPE_MISSING);
});

test("a method that declares no caller, or admits keys without a scope, is refused when defined", () => {
    assert.throws(() => defineMethod({ name: "test.nobody", who: [], params: z.object({}), run: () => null }), /declares no caller/);
    assert.throws(() => defineMethod({ name: "test.anykey", who: ["key"], params: z.object({}), run: () => null }), /without naming the scope/);
    assert.throws(() => defineMethod({ name: "test.humans", who: ["human"], params: z.object({}), run: () => null }), /defined twice/);
    assert.throws(() => defineMethod({ name: "NoDots", who: ["human"], params: z.object({}), run: () => null }), /dotted lowercase/);
});

// --- Calls: results, refusals, protocol errors ---

test("a refusal carries the route's status and aiball's code; a crash says nothing of itself", async () => {
    const c = await connect({ url, token: AGENT });
    const r = await refused(c.call("test.refuse"));
    assert.deepEqual([r.rpcCode, r.status, r.code, r.message, r.details], [409, 409, ERROR_CODES.TICKET_HELD, "held by someone else", { holder: "x" }]);
    const crash = await refused(c.call("test.crash"));
    assert.deepEqual([crash.rpcCode, crash.code, crash.message], [-32603, ERROR_CODES.INTERNAL, "internal error"]);
});

test("an unknown method and invalid params are JSON-RPC errors that still carry aiball's code", async () => {
    const c = await connect({ url, token: AGENT });
    const none = await refused(c.call("no.such"));
    assert.deepEqual([none.rpcCode, none.code], [-32601, ERROR_CODES.NOT_FOUND]);
    const bad = await refused(c.call("test.slow", { ms: "soon" }));
    assert.deepEqual([bad.rpcCode, bad.code], [-32602, ERROR_CODES.BAD_REQUEST]);
    assert.equal((bad.details as { issues: { path: string }[] }).issues[0].path, "ms");
    const extra = await refused(c.call("bus.whoami", { as: "someone" }));
    assert.equal(extra.rpcCode, -32602, "a strict method refuses what it does not take");
});

test("raw frames: not JSON, not JSON-RPC, a notification, an empty or oversized batch", async () => {
    const ws = new WebSocket(`ws+unix:${sockPath}:/bus`);
    const frames: unknown[] = [];
    await new Promise((r) => ws.once("message", r)); // hello
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    const next = async (n: number) => { while (frames.length < n) await new Promise((r) => setTimeout(r, 5)); };
    ws.send("{nope");
    ws.send(JSON.stringify({ id: 1, method: "bus.whoami" }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "test.store", params: { v: "from a notification" } }));
    ws.send(JSON.stringify([]));
    ws.send(JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "bus.whoami" }))));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "test.read" }));
    await next(5);
    const codes = frames.map((f) => (f as { error?: { code: number } }).error?.code ?? "result");
    assert.deepEqual(codes, [-32700, -32600, -32600, -32600, "result"], "the notification got no answer");
    assert.deepEqual(frames[4], { jsonrpc: "2.0", id: 9, result: "from a notification" });
    ws.close();
});

test("a batch runs in order, answers in one frame, and each call settles on its own", async () => {
    const c = await connect({ url, token: AGENT });
    const out = await c.batch([
        { method: "test.store", params: { v: 42 } },
        { method: "test.read" },
        { method: "test.humans" },
        { method: "bus.whoami" },
    ]);
    assert.deepEqual(out.map((o) => o.ok), [true, true, false, true]);
    assert.equal((out[1] as { result: unknown }).result, 42, "a read after a write in the same batch sees it");
    assert.equal((out[2] as { error: { code: string } }).error.code, ERROR_CODES.FORBIDDEN);
});

test("frames on one connection are answered in the order they came", async () => {
    const c = await connect({ url, token: AGENT });
    const order: string[] = [];
    await Promise.all([
        c.call("test.slow", { ms: 60 }).then(() => order.push("slow")),
        c.call("test.read").then(() => order.push("fast")),
    ]);
    assert.deepEqual(order, ["slow", "fast"]);
});

// --- Revocation ---

test("revoking a token closes the connections that rest on it, and only those", async () => {
    const t = issueToken({ kind: "agent", consumer_id: "agent-a", label: "to-revoke" }).token;
    const doomed = await connect({ url, token: t });
    const other = await connect({ url, token: AGENT });
    const closed = doomed.closed();
    deleteToken(t);
    assert.equal(await closed, BUS_CLOSE.TOKEN_REVOKED);
    assert.equal(await other.call<{ consumer: string }>("bus.whoami").then((w) => w.consumer), "agent-a");
    assert.equal((await refused(doomed.call("bus.whoami"))).code, "UNAVAILABLE");
});

test("a token deleted behind the daemon's back (another process) is caught by the sweep", async () => {
    const t = issueToken({ kind: "agent", consumer_id: "agent-a", label: "cli-revoked" }).token;
    const c = await connect({ url, token: t });
    const closed = c.closed();
    getDb().delete(schema.tokens).where(eq(schema.tokens.token, t)).run(); // no notification
    sweepConnections(tcpBus);
    assert.equal(await closed, BUS_CLOSE.TOKEN_REVOKED);
});

test("the local socket rests on no token: nothing to revoke, the sweep leaves it open", async () => {
    const c = await connect({ socket: sockPath, consumer: "agent-a" });
    sweepConnections(tcpBus);
    assert.equal((await c.call<{ transport: string }>("bus.whoami")).transport, "uds");
    assert.ok(busConnectionCountForTests() > 0);
});

async function httpGet(path: string, headers: Record<string, string>, socket?: boolean): Promise<unknown> {
    const { request } = await import("node:http");
    return new Promise((resolve, reject) => {
        const req = request(
            socket ? { socketPath: sockPath, path, headers } : { host: "127.0.0.1", port, path, headers },
            (res) => {
                let body = "";
                res.on("data", (d) => { body += d; });
                res.on("end", () => resolve(JSON.parse(body)));
            },
        );
        req.on("error", reject);
        req.end();
    });
}
