/**
 * The machine secret: a client of this machine over TCP, where the Unix socket
 * is not used (Windows), is treated as the socket's caller — `machine: "local"`
 * — when it bears the secret the daemon wrote for its user, from the loopback.
 * What must hold:
 * - both conditions: the secret, and a loopback peer; neither alone;
 * - a secret-shaped bearer never reaches the token table;
 * - the guards that said "local callers only" accept it, and still refuse a token;
 * - a proxy node checks it and never relays it upstream;
 * - a client only ever sends it to a loopback address.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "aiball-3322-"));
process.env.AIBALL_HOME = HOME;
process.env.AIBALL_SOCK = "";
// The database stays open until the process ends: on Windows the folder cannot be removed before.
after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* EPERM on Windows */ } });

const ms = await import("./machine-secret.js");
const { authenticate } = await import("./auth.js");
const { callerOf, callMethod, Refusal } = await import("./bus/methods.js");
await import("./bus/register.js");
const { relayedBearer, callerOfHello } = await import("./bus/relay.js");
const { proxyMiddleware } = await import("./proxy.js");
const { localMachineSecret } = await import("./client.js");
const { issueToken } = await import("./db/tokens.js");
const { upsertConsumer } = await import("./db.js");

const secret = ms.ensureMachineSecret();
const headers = (h: Record<string, string> = {}) => (name: string) => h[name.toLowerCase()];

test("the secret is created once, kept, and has its own shape", () => {
    assert.match(secret, /^aiball-machine-[0-9a-f]{64}$/);
    assert.equal(ms.ensureMachineSecret(), secret, "kept across restarts");
    assert.equal(ms.readMachineSecret(), secret);
    const bad = join(HOME, "bad-secret");
    writeFileSync(bad, "not a secret\n");
    assert.equal(ms.readMachineSecret(bad), null, "a malformed file is not a secret");
    assert.equal(ms.isMachineSecret(secret), true);
    assert.equal(ms.isMachineSecret(`${secret.slice(0, -1)}0` === secret ? `${secret.slice(0, -1)}1` : `${secret.slice(0, -1)}0`), false);
});

test("loopback: IPv4 127/8, ::1 and IPv4-mapped; nothing else", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) assert.equal(ms.isLoopback(ip), true, ip);
    for (const ip of ["10.0.0.1", "192.168.1.5", "::ffff:10.0.0.1", "", null, undefined, "127.0.0.1.evil"]) assert.equal(ms.isLoopback(ip), false, String(ip));
});

test("the secret from the loopback is a local caller; the identity is the header, human by default", () => {
    const named = authenticate({ transport: "tcp", header: headers({ "x-aiball-consumer": "tvty-win" }), token: secret, ip: "127.0.0.1" });
    assert.ok(named.ok);
    assert.equal(named.ctx.machine, "local");
    assert.equal(named.ctx.consumer_id, "tvty-win");
    assert.equal(named.ctx.token, null, "the secret is not a credential the identity rests on");
    const anonymous = authenticate({ transport: "tcp", header: headers(), token: secret, ip: "::ffff:127.0.0.1" });
    assert.ok(anonymous.ok);
    assert.equal(anonymous.ctx.consumer_id, "human");
});

test("the secret from another host, or a wrong one, is refused — and never looked up as a token", () => {
    const remote = authenticate({ transport: "tcp", header: headers(), token: secret, ip: "192.168.1.5" });
    assert.equal(remote.ok, false);
    assert.equal(!remote.ok && remote.status, 401);
    const wrong = authenticate({ transport: "tcp", header: headers(), token: `aiball-machine-${"0".repeat(64)}`, ip: "127.0.0.1" });
    assert.equal(wrong.ok, false);
    assert.match(!wrong.ok ? wrong.error : "", /machine secret/);
});

test("the machine's guards accept the secret's caller, and still refuse a token over TCP", async () => {
    const local = authenticate({ transport: "tcp", header: headers({ "x-aiball-consumer": "human" }), token: secret, ip: "127.0.0.1" });
    assert.ok(local.ok);
    const list = await callMethod(callerOf(local.ctx), "loop.list", {});
    assert.ok(Array.isArray((list as { loops?: unknown }).loops) || Array.isArray(list), "loop.list answers a local caller");

    upsertConsumer({ consumer_id: "remote-agent", kind: "agent" } as never);
    const t = issueToken({ consumer_id: "remote-agent", kind: "agent", label: "t" });
    const viaToken = authenticate({ transport: "tcp", header: headers(), token: t.token, ip: "127.0.0.1" });
    assert.ok(viaToken.ok);
    assert.notEqual(viaToken.ctx.machine, "local");
    await assert.rejects(() => Promise.resolve(callMethod(callerOf(viaToken.ctx), "loop.list", {})), (e: unknown) => e instanceof Refusal && e.status === 403);
});

test("a proxy node checks the secret and relays without it", () => {
    assert.deepEqual(relayedBearer("aiball-some-token", "10.0.0.2"), { ok: true, bearer: "aiball-some-token", machineLocal: false }, "a token passes through");
    assert.deepEqual(relayedBearer(secret, "127.0.0.1"), { ok: true, bearer: null, machineLocal: true });
    assert.deepEqual(relayedBearer(secret, "192.168.1.5"), { ok: false });
    assert.equal(callerOfHello({ consumer: "tvty-win", kind: "agent" }, false, true).machine, "local");
    assert.equal(callerOfHello({ consumer: "tvty-win", kind: "agent" }, false).machine, undefined);
});

test("the node's HTTP relay sends its own token upstream, never the secret", async () => {
    let seen: string | undefined = "(none)";
    const hub: Server = createServer((req, res) => { seen = req.headers.authorization; res.end("{}"); });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    const relay = proxyMiddleware({ url: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: "aiball-node-token", strict: false } as never, new Map());
    const node: Server = createServer((req, res) => relay(req as never, res as never, () => {}));
    await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
    try {
        const status = await new Promise<number>((resolve, reject) => {
            const r = httpRequest({ host: "127.0.0.1", port: (node.address() as AddressInfo).port, path: "/api/health", headers: { authorization: `Bearer ${secret}` } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
            r.on("error", reject);
            r.end();
        });
        assert.equal(status, 200);
        assert.equal(seen, "Bearer aiball-node-token", "the hub sees the node's token, not the machine secret");
    } finally {
        hub.close();
        node.close();
    }
});

test("a client sends the secret only to a loopback daemon, never over a socket or to another host", () => {
    assert.equal(localMachineSecret(null, "http://127.0.0.1:7777", HOME), secret);
    assert.equal(localMachineSecret(null, "http://localhost:7777", HOME), secret);
    assert.equal(localMachineSecret(null, "http://[::1]:7777", HOME), secret);
    assert.equal(localMachineSecret(null, "https://hub.example:8443", HOME), null);
    assert.equal(localMachineSecret("/run/aiball/sock", "http://127.0.0.1:7777", HOME), null);
    assert.equal(localMachineSecret(null, "http://127.0.0.1:7777", mkdtempSync(join(tmpdir(), "no-secret-"))), null);
});
