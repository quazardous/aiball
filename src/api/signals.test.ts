/**
 * #2255 — external signals. What must hold: a signal key is required on HTTP
 * and on the socket, and opens nothing else; the source comes from the key;
 * a target reaches the named agent or the project owners working on a level;
 * dedup refreshes instead of duplicating, expiry and ack take a signal out of
 * the pending list, a flood gets 429, and the SSE stream carries it. Spawns the
 * real app over HTTP and over a Unix socket tagged like the daemon's.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2255-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { updateConsumer } = await import("../db/consumers.js");
const { getDb } = await import("../db/connection.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { onSignal } = await import("../event-bus.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "coder", kind: "agent" });
upsertConsumer({ consumer_id: "cto", kind: "agent" });
updateConsumer("cto", { agent_type: "cto" });
createProject({ name: "p-2255" });
upsertSubscription("coder", "p-2255", "owner");
upsertSubscription("cto", "p-2255", "owner");
upsertSubscription("boss", "p-2255", "owner");
const KEY = issueToken({ kind: "signal", label: "ext-src" }).token;
const CODER = issueToken({ kind: "agent", consumer_id: "coder", label: "2255-c" }).token;
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2255-h" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const sockDir = mkdtempSync("/tmp/ab-sig-");
const SOCK = join(sockDir, "t.sock");
const uds = createServer(createApp());
uds.on("connection", (s) => { (s as unknown as { __aiballUds: boolean }).__aiballUds = true; });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));

after(() => {
    server.close();
    uds.close();
    for (const d of [process.env.AIBALL_HOME!, sockDir]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Res = { status: number; json: any };
async function http(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}
function sock(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest({
            socketPath: SOCK, path: `/api${path}`, method,
            headers: { "content-type": "application/json", ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}), ...headers },
        }, (res) => {
            let buf = ""; res.on("data", (c) => { buf += c; });
            res.on("end", () => { let json: any; try { json = JSON.parse(buf); } catch { json = buf; } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.on("error", reject); if (data) req.write(data); req.end();
    });
}
const toCoder = (title: string, extra: Record<string, unknown> = {}) => ({ target: { consumer: "coder" }, title, ...extra });

test("over HTTP: no key → 401, an agent token → 403, a signal key → 200 with the key's source", async () => {
    assert.equal((await http("POST", "/signals", toCoder("no key"))).status, 401);
    assert.equal((await http("POST", "/signals", toCoder("agent token"), CODER)).status, 403);
    const ok = await http("POST", "/signals", toCoder("with key", { source: "spoofed" }), KEY);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.source, "ext-src", "the body cannot choose the source");
    assert.deepEqual(ok.json.recipients, ["coder"]);
});

test("on the socket too: no key → 401, an agent token → 403, a signal key → 200", async () => {
    assert.equal((await sock("POST", "/signals", toCoder("uds no key"))).status, 401);
    assert.equal((await sock("POST", "/signals", toCoder("uds agent"), { authorization: `Bearer ${CODER}` })).status, 403);
    const ok = await sock("POST", "/signals", toCoder("uds key"), { authorization: `Bearer ${KEY}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.source, "ext-src");
});

test("a signal key opens nothing else", async () => {
    assert.equal((await http("GET", "/signals", undefined, KEY)).status, 403);
    assert.equal((await http("GET", "/pings", undefined, KEY)).status, 403);
    assert.equal((await http("POST", "/messages", { project: "p-2255", kind: "ticket_created", title: "x", body: "x" }, KEY)).status, 403);
});

test("a project target reaches the owners working on that level, never a human", async () => {
    const roadmap = await http("POST", "/signals", { target: { project: "p-2255", level: "roadmap" }, title: "for the cto" }, KEY);
    assert.deepEqual(roadmap.json.recipients, ["cto"]);
    const task = await http("POST", "/signals", { target: { project: "p-2255", level: "task" }, title: "for coders" }, KEY);
    assert.deepEqual(task.json.recipients, ["coder"]);
});

test("a malformed signal is refused", async () => {
    for (const bad of [
        { target: { consumer: "coder" } },
        { target: { consumer: "coder" }, title: "x".repeat(201) },
        { target: { consumer: "coder", project: "p-2255" }, title: "both" },
        { target: { project: "p-2255" }, title: "no level" },
        { target: { consumer: "coder" }, title: "t", severity: "urgent" },
        { target: { consumer: "coder" }, title: "t", ttl: 90_000 },
    ]) assert.equal((await http("POST", "/signals", bad, KEY)).status, 400, JSON.stringify(bad));
});

test("pending: listed for its recipient, gone once acked; a second ack is a 404", async () => {
    const posted = await http("POST", "/signals", toCoder("to ack"), KEY);
    const listed = await http("GET", "/signals", undefined, CODER);
    assert.ok(listed.json.signals.some((s: any) => s.id === posted.json.id));
    assert.equal((await http("POST", `/signals/${posted.json.id}/ack`, {}, CODER)).status, 200);
    const after = await http("GET", "/signals", undefined, CODER);
    assert.equal(after.json.signals.some((s: any) => s.id === posted.json.id), false);
    assert.equal((await http("POST", `/signals/${posted.json.id}/ack`, {}, CODER)).status, 404);
});

test("an agent cannot read another consumer's signals; a human can", async () => {
    assert.equal((await http("GET", "/signals?consumer_id=cto", undefined, CODER)).status, 403);
    assert.equal((await http("GET", "/signals?consumer_id=cto", undefined, HUMAN)).status, 200);
});

test("same source + dedup_key while unacked refreshes the signal instead of duplicating it", async () => {
    const a = await http("POST", "/signals", toCoder("disk 90%", { dedup_key: "disk" }), KEY);
    const b = await http("POST", "/signals", toCoder("disk 95%", { dedup_key: "disk" }), KEY);
    assert.equal(b.json.id, a.json.id);
    assert.equal(b.json.refreshed, true);
    assert.equal(b.json.repeat_count, 2);
    assert.equal(b.json.title, "disk 95%");
});

test("an expired signal is no longer pending; panic comes first", async () => {
    const old = await http("POST", "/signals", toCoder("stale"), KEY);
    getDb().update(schema.signals).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).where(eq(schema.signals.id, old.json.id)).run();
    const urgent = await http("POST", "/signals", toCoder("urgent", { severity: "panic" }), KEY);
    const pending = (await http("GET", "/signals", undefined, CODER)).json.signals as any[];
    assert.equal(pending.some((s) => s.id === old.json.id), false);
    assert.equal(pending[0].id, urgent.json.id);
});

test("a flood from one source gets 429", async () => {
    const flood = issueToken({ kind: "signal", label: "flood" }).token;
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await http("POST", "/signals", toCoder(`f${i}`), flood)).status;
    assert.equal(last, 429);
});

test("a posted signal is pushed to its recipient, and replayed on the SSE stream at connect", async () => {
    let pushed: any = null;
    const off = onSignal("cto", (e) => { pushed = e; });
    const posted = await http("POST", "/signals", { target: { consumer: "cto" }, title: "push me" }, KEY);
    off();
    assert.equal(pushed?.id, posted.json.id);

    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/events?consumer_id=coder`, { headers: { authorization: `Bearer ${CODER}` }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const deadline = Date.now() + 3000;
    let seen = "";
    while (Date.now() < deadline && !seen.includes("event: signal")) {
        const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 500)),
        ]);
        if (value) seen += new TextDecoder().decode(value);
        if (done && !value) continue;
    }
    ctl.abort();
    assert.match(seen, /event: signal/);
});
