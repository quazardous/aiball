/**
 * #3074 — `consumer.restart_claude`: a loop control (a human's, never through a
 * proxy node), refused when no loop answers or while Claude works; otherwise
 * the loop gets the order on its control stream.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3074-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { getMethod } = await import("./methods.js");
await import("./register.js");
const { accessRefusal } = await import("./methods.js");
const { upsertConsumer } = await import("../db.js");
const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");
const { setAgentBar } = await import("../agent-bar-store.js");
const { onControl } = await import("../event-bus.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const m = getMethod("consumer.restart_claude")!;
const human = { consumer_id: "boss", kind: "human", relayed: false } as never;
const bar = (phase: string) => ({
    phase, presence: "loop", afk: { mode: "off", expires_at: null }, prompt: { visible: true, has_input: false }, human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false, restart_needed: true },
    proxy_alive: true, zen: false, counters: null, next_wake_at: null, boot: null, host: "tmux", attach: { socket: null, reason: "no_socket" },
}) as never;

function refusal(fn: () => unknown): { status: number; code: string } {
    try { fn(); } catch (e) { return e as { status: number; code: string }; }
    assert.fail("expected a refusal");
}

test("a human's gesture, never through a proxy node", () => {
    assert.equal(accessRefusal(m, { consumer_id: "worker", kind: "agent", relayed: false } as never)?.code, "MODERATOR_ONLY");
    assert.equal(accessRefusal(m, { consumer_id: "boss", kind: "human", relayed: true } as never)?.code, "FORBIDDEN");
    assert.equal(accessRefusal(m, human), null);
});

test("no loop answering, or Claude at work: refused, nothing sent", () => {
    const got: unknown[] = [];
    const off = onControl("worker", (c) => got.push(c));
    assert.equal(refusal(() => m.run(human, { name: "worker" })).code, "LOOP_NOT_FOUND");
    presenceConnect("worker", "terminal");
    setAgentBar("worker", bar("busy"));
    assert.deepEqual([refusal(() => m.run(human, { name: "worker" })).status, refusal(() => m.run(human, { name: "worker" })).code], [409, "NOT_IDLE"]);
    assert.deepEqual(got, []);
    off();
    presenceDisconnect("worker");
});

test("Claude idle: the loop gets the order", () => {
    const got: unknown[] = [];
    const off = onControl("worker", (c) => got.push(c));
    presenceConnect("worker", "terminal");
    setAgentBar("worker", bar("idle"));
    assert.deepEqual(m.run(human, { name: "worker" }), { consumer_id: "worker", queued: true });
    assert.deepEqual(got, [{ action: "restart_claude" }]);
    off();
    presenceDisconnect("worker");
});

upsertConsumer({ consumer_id: "idler", kind: "agent" });

test("#3117 when_idle: while Claude works the order goes through, marked when_idle; without a loop still refused", () => {
    const got: unknown[] = [];
    const off = onControl("idler", (c) => got.push(c));
    assert.equal(refusal(() => m.run(human, { name: "idler", when_idle: true })).code, "LOOP_NOT_FOUND");
    presenceConnect("idler", "terminal");
    setAgentBar("idler", bar("busy"));
    assert.deepEqual(m.run(human, { name: "idler", when_idle: true }), { consumer_id: "idler", queued: true, when_idle: true });
    assert.deepEqual(got, [{ action: "restart_claude", when_idle: true }]);
    off();
    presenceDisconnect("idler");
});
