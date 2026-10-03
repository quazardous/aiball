/**
 * #3030 — an agent's loop bar as data, over the bus:
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

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3030-"));
process.env.AIBALL_SOCK = "";
process.env.AIBALL_PRESENCE_GRACE_MS = "20";

const { asToken } = await import("../tests/bus-call.js");
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

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    return asToken<Record<string, unknown>>(token, method, params);
}

const bar = (over: Record<string, unknown> = {}) => ({
    phase: "idle",
    presence: "loop",
    afk: { mode: "wait_10m", expires_at: "2026-09-26T10:00:00.000Z" },
    prompt: { visible: true, has_input: false },
    human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false, restart_needed: false, restart_pending: false, limit_reached: false },
    limit_resets: null,
    model: null,
    remote_control: { on: false },
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
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar() })).status, 200);
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "other", bar: bar() })).status, 403);
    assert.equal((await call(HUMAN, "consumer.push_bar", { consumer_id: "boss", bar: bar() })).status, 403);
});

test("a bar that is not one is refused whole", async () => {
    const r = await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ phase: "napping" }) });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /phase/);
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ afk: { mode: "off", expires_at: "in 5 min" } }) })).status, 400, "a countdown is not a date");
});

test("an identical push is not a change; a different one is", async () => {
    await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar() });
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar() })).json.changed, false);
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ phase: "busy" }) })).json.changed, true);
});

test("a human or the agent itself reads the bar; another agent does not; none pushed is a 404", async () => {
    await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ human_typing: true }) });
    const r = await call(HUMAN, "consumer.bar", { consumer_id: "worker" });
    assert.equal(r.status, 200);
    assert.equal((r.json.bar as { human_typing: boolean }).human_typing, true);
    assert.equal(r.json.consumer_id, "worker");
    assert.equal((await call(WORKER, "consumer.bar", { consumer_id: "worker" })).status, 200);
    assert.equal((await call(OTHER, "consumer.bar", { consumer_id: "worker" })).status, 403);
    assert.equal((await call(HUMAN, "consumer.bar", { consumer_id: "other" })).status, 404);
});

test("the bar is stale unless its loop is present", async () => {
    await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar() });
    assert.equal((await call(HUMAN, "consumer.bar", { consumer_id: "worker" })).json.stale, true, "no loop connected");
    presenceConnect("worker");
    assert.equal((await call(HUMAN, "consumer.bar", { consumer_id: "worker" })).json.stale, false);
    presenceDisconnect("worker");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await call(HUMAN, "consumer.bar", { consumer_id: "worker" })).json.stale, true, "the loop stopped");
});

test("the shape the daemon accepts round-trips unchanged", () => {
    assert.deepEqual(parseAgentBar(bar()), bar());
    assert.deepEqual(parseAgentBar(bar({ host: "external" })), bar({ host: "external" }));
});

test("#3268 — a usage limit: its alert and reset round-trip; a loop started before the fields sends neither; a malformed reset is refused", () => {
    const hit = bar({ alerts: { ...bar().alerts, limit_reached: true }, limit_resets: { text: "in 3h 20m", at: "2026-09-28T20:00:00.000Z" } });
    assert.deepEqual(parseAgentBar(hit), hit);
    const { limit_resets: _r, ...old } = bar();
    const { limit_reached: _l, ...oldAlerts } = bar().alerts;
    const parsed = parseAgentBar({ ...old, alerts: oldAlerts }) as { alerts: { limit_reached: boolean }; limit_resets: unknown };
    assert.equal(parsed.alerts.limit_reached, false);
    assert.equal(parsed.limit_resets, null);
    assert.match(String((parseAgentBar(bar({ limit_resets: { text: 3 } })) as { error: string }).error), /limit_resets/);
});

test("#3283 — the model: it round-trips; a loop started before the field sends none; a malformed one is refused", () => {
    const on = bar({ model: { id: "claude-opus-5-5", name: "Opus 5.5" } });
    assert.deepEqual(parseAgentBar(on), on);
    const { model: _m, ...old } = bar();
    assert.equal((parseAgentBar(old) as { model: unknown }).model, null);
    assert.match(String((parseAgentBar(bar({ model: { id: "claude-opus-5-5" } })) as { error: string }).error), /model/);
});

test("#3291 — Remote Control: it round-trips; a loop started before the field says off; a malformed one is refused", () => {
    const on = bar({ remote_control: { on: true } });
    assert.deepEqual((parseAgentBar(on) as { remote_control: unknown }).remote_control, { on: true });
    const { remote_control: _rc, ...old } = bar();
    assert.deepEqual((parseAgentBar(old) as { remote_control: unknown }).remote_control, { on: false });
    assert.match(String((parseAgentBar(bar({ remote_control: { on: "yes" } })) as { error: string }).error), /remote_control/);
});

test("#3044 — a bar without host (a loop started before the field) draws in tmux; an unknown host is refused", () => {
    const { host: _h, ...old } = bar();
    assert.equal((parseAgentBar(old) as { host: string }).host, "tmux");
    assert.match(String((parseAgentBar(bar({ host: "web" })) as { error: string }).error), /host/);
});

test("#3507 — the denied tool calls: pushed, kept and read back; a loop started before the field sends none; a malformed one is refused", async () => {
    const denials = { last_hour: 3, total: 5, last_at: "2026-10-03T09:00:00.000Z", last_reason: "Auto-Mode Bypass" };
    assert.equal((await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ denials }) })).status, 200);
    assert.deepEqual(((await call(HUMAN, "consumer.bar", { consumer_id: "worker" })).json.bar as { denials: unknown }).denials, denials, "what a client reads");
    assert.equal((parseAgentBar(bar({ denials: null })) as { denials: unknown }).denials, null, "none in the last hour");
    assert.ok(!("denials" in (parseAgentBar(bar()) as object)), "a loop started before the field: absent, as sent");
    const withSent = { ...denials, sent: 2 };
    assert.deepEqual((parseAgentBar(bar({ denials: withSent })) as { denials: unknown }).denials, withSent, "#3509 — the prompts sent, kept");
    for (const bad of [{ ...denials, sent: -1 }, { ...denials, last_hour: -1 }, { ...denials, total: "5" }, { ...denials, last_at: "2 min ago" }, { ...denials, last_reason: 7 }, "3"]) {
        const r = await call(WORKER, "consumer.push_bar", { consumer_id: "worker", bar: bar({ denials: bad }) });
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.match(String(r.json.error), /denials/);
    }
});
