/**
 * #3066 — the daemon's sessions: started detached on a real `cl-session-host`,
 * listed and published, one per name (HOST_BUSY), a human's gesture, found
 * again after the daemon restarts, stopped with their files. Needs the host
 * built (cargo); skipped, and says so, without it.
 */
import { test, after } from "node:test";
import { refused } from "../tests/lib.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3066-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { createApp } = await import("../app.js");
const { attachBus } = await import("../bus/server.js");
const { upsertConsumer } = await import("../db.js");
const { issueToken } = await import("../db/tokens.js");
const { BusClient } = await import("../bus-client.js");
const { forgetSessionsForTests, initSessions, listSessionViews } = await import("./registry.js");
const { allowedEnv, resetLoginEnvForTests } = await import("./env.js");
const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "human", kind: "human" });
upsertConsumer({ consumer_id: "hosted", kind: "agent" });
const NODE = issueToken({ kind: "node", label: "n" }).token;
resetLoginEnvForTests({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

const sockPath = join(home, "bus.sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));
const tcp = createServer(createApp());
attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(tcp.address() as { port: number }).port}`;

const clients: { close(): void }[] = [];
async function as(consumer: string) {
    const c = await BusClient.connect({ socket: sockPath, consumer });
    clients.push(c);
    return c;
}
async function stopAll() {
    const boss = await as("boss");
    for (const v of listSessionViews()) await boss.call("session.stop", v.name ? { name: v.name, wait: true } : { agent: v.agent, wait: true }).catch(() => {});
}
after(async () => {
    await stopAll().catch(() => {});
    for (const c of clients) c.close();
    uds.closeAllConnections(); uds.close();
    tcp.closeAllConnections(); tcp.close();
    rmSync(home, { recursive: true, force: true });
});

test("a named session: started detached, listed, one per name, stopped with its files", { skip }, async () => {
    const boss = await as("boss");
    const v = await boss.call<{ name: string; running: boolean; attach: { socket: string }; pid: number }>("session.start", { name: "shell", argv: ["cat"], cwd: home, size: { rows: 20, cols: 70 } });
    assert.equal(v.name, "shell");
    assert.equal(v.running, true);
    assert.ok(existsSync(v.attach.socket), "its attach socket, for clients");
    assert.deepEqual((await boss.call<{ name: string }[]>("session.list")).map((s) => s.name), ["shell"]);
    const busy = await refused(boss.call("session.start", { name: "shell", argv: ["cat"], cwd: home }));
    assert.deepEqual([busy.status, busy.code], [409, "HOST_BUSY"]);
    await boss.call("session.stop", { name: "shell" });
    const deadline = Date.now() + 5000;
    while (existsSync(join(home, "hosts", "term-shell")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!existsSync(join(home, "hosts", "term-shell")), "the host removed its files");
    const gone = () => { try { process.kill(v.pid, 0); return false; } catch { return true; } };
    while (!gone() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(gone(), "the host process is gone");
});

test("the daemon finds its hosts again after a restart", { skip }, async () => {
    const boss = await as("boss");
    const v = await boss.call<{ pid: number }>("session.start", { name: "survivor", argv: ["cat"], cwd: home });
    forgetSessionsForTests(); // what a daemon restart forgets
    assert.equal(listSessionViews().length, 0);
    assert.equal(await initSessions(), 1, "taken back from host.json");
    const again = listSessionViews()[0];
    assert.deepEqual([again.name, again.pid, again.running], ["survivor", v.pid, true]);
    await boss.call("session.stop", { name: "survivor", wait: true });
});

test("session.<name>.state: a session started after the subscription is heard", { skip }, async () => {
    const boss = await as("boss");
    const events: unknown[] = [];
    const ws = (boss as unknown as { ws: { on(e: string, f: (d: unknown) => void): void } }).ws;
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.method === "bus.event") events.push(m.params); });
    const sub = await boss.call<{ value: Record<string, unknown> }>("bus.subscribe", { subject: "session.*.state" });
    assert.deepEqual(sub.value, {});
    await boss.call("session.start", { name: "later", argv: ["cat"], cwd: home });
    await new Promise((r) => setTimeout(r, 100));
    const ev = events.find((e) => (e as { subject: string }).subject === "session.later.state") as { data: { session: { running: boolean } } } | undefined;
    assert.ok(ev, "the new session is announced");
    assert.equal(ev.data.session.running, true);
    await boss.call("session.stop", { name: "later", wait: true });
});

test("starting a session is a human's gesture, never through a proxy node", { skip }, async () => {
    const worker = await as("worker");
    assert.equal((await refused(worker.call("session.start", { name: "x", argv: ["cat"], cwd: home }))).code, "MODERATOR_ONLY");
    const relayed = await BusClient.connect({ url, token: NODE, consumer: "boss" });
    clients.push(relayed);
    const r = await refused(relayed.call("session.start", { name: "x", argv: ["cat"], cwd: home }));
    assert.equal(r.code, "FORBIDDEN");
    assert.match(r.message, /proxy node/);
    assert.equal(listSessionViews().length, 0, "nothing started");
});

test("an agent in claude-loop is HOST_BUSY", { skip }, async () => {
    const boss = await as("boss");
    presenceConnect("worker", "terminal");
    const busy = await refused(boss.call("session.start", { agent: "worker", cwd: home }));
    assert.deepEqual([busy.code, (busy as unknown as { details: { host: string } }).details.host], ["HOST_BUSY", "claude-loop"]);
    presenceDisconnect("worker");
});

test("#3141 a name too long for the socket path starts all the same, in a short folder", { skip }, async () => {
    const boss = await as("boss");
    const name = "n".repeat(64);
    const v = await boss.call<{ name: string; attach: { socket: string } }>("session.start", { name, argv: ["cat"], cwd: home });
    assert.equal(v.name, name);
    assert.match(v.attach.socket, /term-[0-9a-f]{8}\/attach\.sock$/);
    await boss.call("session.stop", { name, wait: true });
});

test("the environment a caller may give: an allow-list", () => {
    assert.deepEqual(allowedEnv({ PATH: "/x", LANG: "fr_FR.UTF-8", LC_ALL: "C", LD_PRELOAD: "/evil.so", NODE_OPTIONS: "--require x", HOME: "/elsewhere", n: 3 }), { PATH: "/x", LANG: "fr_FR.UTF-8", LC_ALL: "C" });
});

test("#3125 — the keys the host watches for a loop pass the allow-list; nothing else new does", () => {
    const keys = { CL_AFK_SPEC: "[]", CL_AFK_WINDOW_MS: "400", CL_ESC_TAKEOVER: "1", CL_RELOAD_KEY: "0e" };
    assert.deepEqual(allowedEnv({ ...keys, CL_HOST_CONTROL: "/elsewhere.sock", CL_OTHER: "x" }), keys);
});

test("#3125 — a session on the host gets a terminal that renders colours, and the AFK key the loop gives", { skip }, async () => {
    const worker = await as("worker");
    const out = join(home, "env-seen");
    const argv = ["sh", "-c", `printf '%s|%s|%s' "$TERM" "$COLORTERM" "$CL_AFK_SPEC" > '${out}'; exec cat`];
    await worker.call("session.host", { agent: "hosted", argv, cwd: home, env: { CL_AFK_SPEC: "[[27,91,50,48,126]]" } });
    try {
        const deadline = Date.now() + 5000;
        while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(readFileSync(out, "utf8"), "xterm-256color|truecolor|[[27,91,50,48,126]]");
    } finally {
        // Stopped whatever happens: the next test starts the same agent.
        await (await as("hosted")).call("session.stop", { agent: "hosted", wait: true });
    }
});

test("the loop's parameters: a name is a session without an agent, not with agent or crew", { skip }, async () => {
    const boss = await as("boss");
    assert.equal((await refused(boss.call("session.start", { name: "t", agent: "worker", argv: ["cat"], cwd: home }))).status, 400);
    assert.equal((await refused(boss.call("session.start", { agent: "worker", crew: "helper", cwd: home }))).status, 400);
    assert.equal((await refused(boss.call("session.start", { name: "t", argv: ["cat"], cwd: home, remote_control: true }))).status, 400, "#3254 — a named session runs no Claude");
    assert.equal((await refused(boss.call("session.start", { agent: "worker", cwd: home, remote_control: "--model" }))).status, 400, "#3254 — a name, not a flag");
});

test("session.host: local callers only, and one session per agent", { skip }, async () => {
    const worker = await as("worker");
    const hosted = await worker.call<{ agent: string; control: string; attach: { socket: string } }>("session.host", { agent: "hosted", argv: ["cat"], cwd: home });
    assert.equal(hosted.agent, "hosted");
    assert.ok(existsSync(hosted.control), "the control socket the kernel is given");
    const busy = await refused(worker.call("session.host", { agent: "hosted", argv: ["cat"], cwd: home }));
    assert.deepEqual([busy.status, busy.code], [409, "HOST_BUSY"]);
    const remote = await BusClient.connect({ url, token: issueToken({ kind: "agent", consumer_id: "worker", label: "w2" }).token });
    clients.push(remote);
    assert.equal((await refused(remote.call("session.host", { agent: "other", argv: ["cat"], cwd: home }))).status, 403, "not over TCP");
    const other = await refused(worker.call("session.stop", { agent: "hosted" }));
    assert.equal(other.code, "MODERATOR_ONLY", "an agent stops its own session, not another's");
    const own = await as("hosted");
    await own.call("session.stop", { agent: "hosted", wait: true });
    assert.equal(listSessionViews().filter((v) => v.agent === "hosted").length, 0, "its own loop's rm stops it");
});

test("#3481 a label for a session without an agent: given, heard, kept across a daemon restart, taken away; never its key", { skip }, async () => {
    const boss = await as("boss");
    const events: Array<{ subject: string; data: { session: { label: string | null } | null } }> = [];
    const ws = (boss as unknown as { ws: { on(e: string, f: (d: unknown) => void): void } }).ws;
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.method === "bus.event") events.push(m.params.data ? { subject: m.params.subject, data: m.params.data } : m.params); });
    await boss.call("bus.subscribe", { subject: "session.*.state" });
    await boss.call("session.start", { name: "term-9", argv: ["cat"], cwd: home });
    const labelled = await boss.call<{ name: string; label: string | null }>("session.label", { name: "term-9", label: "  build watch  " });
    assert.deepEqual([labelled.name, labelled.label], ["term-9", "build watch"], "trimmed; the name stays the key");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.some((e) => e.subject === "session.term-9.state" && e.data.session?.label === "build watch"), "every client hears it");
    assert.equal((await boss.call<Array<{ name: string; label: string | null }>>("session.list")).find((s) => s.name === "term-9")?.label, "build watch");
    forgetSessionsForTests(); // a daemon restart
    await initSessions();
    assert.equal(listSessionViews().find((s) => s.name === "term-9")?.label, "build watch", "kept with the host's files");
    assert.equal((await boss.call<{ label: string | null }>("session.label", { name: "term-9", label: null })).label, null, "null takes it away");
    assert.equal((await refused(boss.call("session.label", { name: "term-9", label: "   " }))).status, 400);
    assert.equal((await refused(boss.call("session.label", { name: "nobody", label: "x" }))).status, 404);
    assert.equal((await refused((await as("worker")).call("session.label", { name: "term-9", label: "x" }))).code, "MODERATOR_ONLY", "a human's gesture");
    await boss.call("session.stop", { name: "term-9", wait: true });
});
