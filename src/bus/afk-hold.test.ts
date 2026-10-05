/**
 * #3594 — an agent's hold (AFK) is its state, kept by aiball even while no
 * loop runs: set for an agent without a live loop, kept from the bar a loop
 * pushes (not while it boots), from a `consumer.afk` order, and shown by
 * `loop.list` for a stopped loop.
 */
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3594-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3594-tmux-");
delete process.env.TMUX;
after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

const { callMethod, getMethod } = await import("./methods.js");
await import("./register.js");
const { upsertConsumer } = await import("../db.js");
const { getConsumer } = await import("../db/consumers.js");
const { onBroadcast } = await import("../ws.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "shut-one", kind: "agent" });
upsertConsumer({ consumer_id: "looped", kind: "agent" });
const human = testCaller("boss", { kind: "human" });
const setHold = getMethod("consumer.set_afk_hold")!;
const hold = (id: string) => getConsumer(id)?.afk_hold;

const bar = (phase: string, mode: string) => ({
    phase, presence: "loop", afk: { mode, expires_at: mode === "wait_10m" ? "2026-10-05T10:00:00.000Z" : null },
    prompt: { visible: true, has_input: false }, human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false },
    proxy_alive: true, zen: false, counters: null, next_wake_at: null, boot: null, host: "tmux", attach: { socket: null, reason: "no_socket" },
});

test("an agent without a loop: off by default, set and announced, no loop told", async () => {
    assert.equal(hold("shut-one"), "off");
    const heard: unknown[] = [];
    const off = onBroadcast((ev) => { if (ev.type === "consumer_changed") heard.push(ev.data); });
    assert.deepEqual(await setHold.run(human, { name: "shut-one", afk: "wait_inf" }), { consumer_id: "shut-one", afk_hold: "wait_inf", applied: false });
    assert.equal(hold("shut-one"), "wait_inf");
    assert.equal((heard[0] as { afk_hold: string }).afk_hold, "wait_inf", "every client hears it");
    off();
});

test("a human's gesture; an unknown agent or a human is a 404; only off or wait_inf", async () => {
    assert.equal((await refused(callMethod(testCaller("looped"), "consumer.set_afk_hold", { name: "shut-one", afk: "off" }))).code, "MODERATOR_ONLY");
    assert.equal((await refused(callMethod(human, "consumer.set_afk_hold", { name: "shut-one", afk: "wait_10m" }))).status, 400, "a delay is not a hold");
    assert.equal((await refused(() => setHold.run(human, { name: "nobody", afk: "off" }))).status, 404);
    assert.equal((await refused(() => setHold.run(human, { name: "boss", afk: "off" }))).status, 404);
});

test("the bar a loop pushes keeps the hold, but not while it boots; a 10-minute hold is kept as off", async () => {
    const push = getMethod("consumer.push_bar")!;
    const looped = testCaller("looped");
    await push.run(looped, { consumer_id: "looped", bar: bar("boot", "off") });
    assert.equal(hold("looped"), "off");
    await push.run(looped, { consumer_id: "looped", bar: bar("idle", "wait_inf") });
    assert.equal(hold("looped"), "wait_inf");
    await push.run(looped, { consumer_id: "looped", bar: bar("boot", "off") });
    assert.equal(hold("looped"), "wait_inf", "a boot says nothing yet: the hold it starts in is armed then");
    await push.run(looped, { consumer_id: "looped", bar: bar("busy", "wait_10m") });
    assert.equal(hold("looped"), "off", "a delay, not a state");
});

test("a consumer.afk order is kept as the hold too, even if the loop is still booting; loop.list shows it for a stopped loop", async () => {
    mkdirSync(join(home, "loops", "cl-looped"), { recursive: true });
    writeFileSync(join(home, "loops", "cl-looped", "plate.json"), JSON.stringify({ name: "cl-looped", agent: "looped", cwd: "/w/looped", created_at: "2026-10-05T00:00:00Z" }));
    const afk = getMethod("consumer.afk")!;
    await afk.run(human, { name: "looped", action: "arm_inf" });
    assert.equal(hold("looped"), "wait_inf", "no socket to reach: the order is not lost, the loop starts in it");
    const loops = await getMethod("loop.list")!.run(human, {}) as Array<{ name: string; running: boolean; afk_hold: string }>;
    const l = loops.find((x) => x.name === "cl-looped")!;
    assert.deepEqual([l.running, l.afk_hold], [false, "wait_inf"]);
    await afk.run(human, { name: "looped", action: "off" });
    assert.equal(hold("looped"), "off");
});
