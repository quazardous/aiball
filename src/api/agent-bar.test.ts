/**
 * #3030 — an agent's loop bar as data, over the real routes:
 * - an agent pushes its own bar, never another's, and a human pushes none;
 * - a bar that is not one is refused, whole;
 * - a human, or the agent itself, reads it; another agent does not;
 * - an identical push is not a change; a different one is;
 * - the bar is stale while its loop is not present, and live while it is.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3030-"));
process.env.AIBALL_SOCK = "";
process.env.AIBALL_PRESENCE_GRACE_MS = "20";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");
const { parseAgentBar } = await import("../agent-bar.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3030-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3030-w" }).token;
const OTHER = issueToken({ kind: "agent", consumer_id: "other", label: "3030-o" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}

const bar = (over: Record<string, unknown> = {}) => ({
    phase: "idle",
    presence: "loop",
    afk: { mode: "wait_10m", expires_at: "2026-09-26T10:00:00.000Z" },
    prompt: { visible: true, has_input: false },
    human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false, restart_needed: false, restart_pending: false },
    proxy_alive: true,
    zen: false,
    counters: { open: 3, backlog: 1, events: 0 },
    next_wake_at: "2026-09-26T09:30:00.000Z",
    boot: null,
    host: "tmux",
    attach: { socket: null, reason: "no_socket" },
    ...over,
});

test("an agent pushes its own bar; not another's; a human pushes none", async () => {
    assert.equal((await call(WORKER, "PUT", "/api/consumers/worker/bar", bar())).status, 200);
    assert.equal((await call(WORKER, "PUT", "/api/consumers/other/bar", bar())).status, 403);
    assert.equal((await call(HUMAN, "PUT", "/api/consumers/boss/bar", bar())).status, 403);
});

test("a bar that is not one is refused whole", async () => {
    const r = await call(WORKER, "PUT", "/api/consumers/worker/bar", bar({ phase: "napping" }));
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /phase/);
    assert.equal((await call(WORKER, "PUT", "/api/consumers/worker/bar", bar({ afk: { mode: "off", expires_at: "in 5 min" } }))).status, 400, "a countdown is not a date");
});

test("an identical push is not a change; a different one is", async () => {
    await call(WORKER, "PUT", "/api/consumers/worker/bar", bar());
    assert.equal((await call(WORKER, "PUT", "/api/consumers/worker/bar", bar())).json.changed, false);
    assert.equal((await call(WORKER, "PUT", "/api/consumers/worker/bar", bar({ phase: "busy" }))).json.changed, true);
});

test("a human or the agent itself reads the bar; another agent does not; none pushed is a 404", async () => {
    await call(WORKER, "PUT", "/api/consumers/worker/bar", bar({ human_typing: true }));
    const r = await call(HUMAN, "GET", "/api/consumers/worker/bar");
    assert.equal(r.status, 200);
    assert.equal((r.json.bar as { human_typing: boolean }).human_typing, true);
    assert.equal(r.json.consumer_id, "worker");
    assert.equal((await call(WORKER, "GET", "/api/consumers/worker/bar")).status, 200);
    assert.equal((await call(OTHER, "GET", "/api/consumers/worker/bar")).status, 403);
    assert.equal((await call(HUMAN, "GET", "/api/consumers/other/bar")).status, 404);
});

test("the bar is stale unless its loop is present", async () => {
    await call(WORKER, "PUT", "/api/consumers/worker/bar", bar());
    assert.equal((await call(HUMAN, "GET", "/api/consumers/worker/bar")).json.stale, true, "no loop connected");
    presenceConnect("worker");
    assert.equal((await call(HUMAN, "GET", "/api/consumers/worker/bar")).json.stale, false);
    presenceDisconnect("worker");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await call(HUMAN, "GET", "/api/consumers/worker/bar")).json.stale, true, "the loop stopped");
});

test("the shape the daemon accepts round-trips unchanged", () => {
    assert.deepEqual(parseAgentBar(bar()), bar());
    assert.deepEqual(parseAgentBar(bar({ host: "external" })), bar({ host: "external" }));
});

test("#3044 — a bar without host (a loop started before the field) draws in tmux; an unknown host is refused", () => {
    const { host: _h, ...old } = bar();
    assert.equal((parseAgentBar(old) as { host: string }).host, "tmux");
    assert.match(String((parseAgentBar(bar({ host: "web" })) as { error: string }).error), /host/);
});
