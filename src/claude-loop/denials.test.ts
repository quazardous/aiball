/**
 * #3500 — the denied tool calls, counted with time: the last hour's count and
 * the last one's age for the bar (`⛔N·age`), a summary for hosts, the hour
 * forgotten as it passes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENIAL_WINDOW_MS, denialChip, denialSummary, emptyDenialLog, withDenial } from "./denials.js";
import { getIpcState, resetIpcStateForTests } from "./ipc-state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";
import { barOptionValues, computeAgentBar, type BarColors, type BarSnapshot } from "./bar-renderer.js";
import { snapshotFromAgentBar } from "./attach-bar.js";
import { sampleBar } from "./attach-bar.fixture.js";
import { HOOKS } from "./hooks/registry.js";

const T0 = Date.parse("2026-10-03T08:00:00Z");
const MIN = 60_000;
const sd = mkdtempSync(join(tmpdir(), "denials-"));
after(() => rmSync(sd, { recursive: true, force: true }));

test("counted with time: the last hour's, the total, the last one's reason", () => {
    let log = emptyDenialLog();
    assert.equal(denialSummary(log, T0), null, "none: nothing to show");
    log = withDenial(log, T0, "Auto-Mode Bypass");
    log = withDenial(log, T0 + 30 * MIN, "x".repeat(500));
    log = withDenial(log, T0 + 70 * MIN, "Auto-Mode Bypass");
    const s = denialSummary(log, T0 + 72 * MIN)!;
    assert.equal(s.last_hour, 2, "the first one is more than an hour old");
    assert.equal(s.total, 3, "the total runs since the start");
    assert.equal(s.last_at, new Date(T0 + 70 * MIN).toISOString());
    assert.equal(s.last_reason, "Auto-Mode Bypass");
    assert.equal(withDenial(emptyDenialLog(), T0, "y".repeat(500)).lastReason!.length, 200, "a long reason is cut");
    assert.equal(denialSummary(log, T0 + 70 * MIN + DENIAL_WINDOW_MS), null, "an hour without one: gone");
});

test("the chip: how many in the hour, and how long ago the last", () => {
    const at = new Date(T0).toISOString();
    assert.equal(denialChip({ last_hour: 3, last_at: at }, T0 + 40_000), "⛔3·40s");
    assert.equal(denialChip({ last_hour: 3, last_at: at }, T0 + 2 * MIN + 5_000), "⛔3·2m");
    assert.equal(denialChip({ last_hour: 1, last_at: at }, T0 + DENIAL_WINDOW_MS), "", "an hour on: gone");
    assert.equal(denialChip(null, T0), "");
});

test("the PermissionDenied hook event is counted, logged, and reaches the agent bar", () => {
    resetIpcStateForTests();
    const now = Date.now();
    const v = dispatchProxyEvent(sd, { event: "hook", kind: "PermissionDenied", tool_name: "Bash", reason: "Auto-Mode Bypass", at_ms: now - 1000 });
    assert.deepEqual(v, { kind: "denial-recorded", tool: "Bash", reason: "Auto-Mode Bypass" });
    assert.equal(formatVerdictLogLine(v), 'proxy-event: permission denied (tool=Bash) reason="Auto-Mode Bypass"');
    assert.equal(getIpcState().denials.total, 1);
    const bar = computeAgentBar(sd, now);
    assert.deepEqual(bar.denials, { last_hour: 1, total: 1, last_at: new Date(now - 1000).toISOString(), last_reason: "Auto-Mode Bypass", sent: 0 });
});

const COL: BarColors = { island_fg: "colour250", bar_fg: "colour16", afk_label_fg: "colour238", prompt_input_fg: "colour208", busy_bg: "colour33", idle_bg: "colour34", boot_bg: "colour178", link_down_bg: "colour196" };

test("tmux's bar and the attach bar show the same chip after the counters", () => {
    const now = T0 + 2 * MIN;
    const fromBar = snapshotFromAgentBar({ bar: { ...sampleBar(), denials: { last_hour: 3, total: 4, last_at: new Date(T0).toISOString(), last_reason: "r" } }, stale: false }, now, COL);
    assert.equal(fromBar.denialChip, "⛔3·2m");
    assert.match(barOptionValues(fromBar, COL)["@cl_counts"], / e:- ⛔3·2m$/);
    const none: BarSnapshot = { ...fromBar, denialChip: "" };
    assert.doesNotMatch(barOptionValues(none, COL)["@cl_counts"], /⛔/);
    assert.equal(snapshotFromAgentBar({ bar: sampleBar(), stale: false }, now, COL).denialChip, "", "a loop started before it sends none");
});

test("the hook is registered, without a matcher: every denied tool counts", () => {
    const spec = HOOKS.find((h) => h.event === "PermissionDenied");
    assert.ok(spec);
    assert.equal(spec!.matchers, undefined);
});
