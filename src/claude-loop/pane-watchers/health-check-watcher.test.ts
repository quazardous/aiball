/**
 * #949 — HealthCheckWatcher tests. node:test, no I/O.
 *
 * Watcher detects Claude Code's NATIVE feedback prompt in the pane
 * footer ; emits begin/end on visibility transitions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthCheckWatcher, _isNativePromptVisibleForTests as isVisible } from "./health-check-watcher.js";

const CTX = { nowMs: 1_700_000_000_000 };
const PROMPT = "How are you doing in this session? Respond with ONLY a single digit 1-5 (1=struggling, 5=cruising).";

test("detects the native prompt in the footer", () => {
    const w = new HealthCheckWatcher();
    const pane = ["claude output", "──────", PROMPT].join("\n");
    const s = w.observe(pane, CTX);
    assert.equal(s.visible, true);
});

test("clean pane → not visible", () => {
    const w = new HealthCheckWatcher();
    assert.equal(w.observe("nothing here", CTX).visible, false);
});

test("ignores prompt-line ('> ' / '❯ ') quoting the question (humans typing about it)", () => {
    const w = new HealthCheckWatcher();
    const pane = ["claude output", "> How are you doing in this session?"].join("\n");
    assert.equal(w.observe(pane, CTX).visible, false);
    const w2 = new HealthCheckWatcher();
    const pane2 = ["claude output", "❯ How are you doing in this session?"].join("\n");
    assert.equal(w2.observe(pane2, CTX).visible, false);
});

test("scans only the footer (last N lines)", () => {
    const w = new HealthCheckWatcher();
    const filler = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const pane = PROMPT + "\n" + filler;
    // Prompt is now far above the 12-line footer window → not visible.
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("emits begin on null → visible, end on visible → null", () => {
    const w = new HealthCheckWatcher();
    const beginFired: boolean[] = [];
    const endFired: boolean[] = [];
    w.on("begin", () => beginFired.push(true));
    w.on("end", () => endFired.push(true));
    w.observe("nothing", CTX);
    assert.deepEqual(beginFired, []);
    assert.deepEqual(endFired, []);
    w.observe(PROMPT, CTX);
    assert.deepEqual(beginFired, [true]);
    assert.deepEqual(endFired, []);
    // Same state → no re-emit (idempotent).
    w.observe(PROMPT, CTX);
    assert.deepEqual(beginFired, [true]);
    // Prompt scrolls out → end fires.
    w.observe("clean pane", CTX);
    assert.deepEqual(endFired, [true]);
    // Re-appearance fires begin again (not one-shot).
    w.observe(PROMPT, CTX);
    assert.deepEqual(beginFired, [true, true]);
});

test("emits change on every transition (begin OR end)", () => {
    const w = new HealthCheckWatcher();
    const changes: boolean[] = [];
    w.on("change", (next) => changes.push(next.visible));
    w.observe("nothing", CTX);
    assert.deepEqual(changes, []);
    w.observe(PROMPT, CTX);
    assert.deepEqual(changes, [true]);
    w.observe("clean", CTX);
    assert.deepEqual(changes, [true, false]);
});

test("reset() drops state and listeners", () => {
    const w = new HealthCheckWatcher();
    w.observe(PROMPT, CTX);
    assert.equal(w.snapshot().visible, true);
    w.reset();
    assert.equal(w.snapshot().visible, false);
    // Listener attached post-reset DOES fire on the next transition
    // (= reset cleared the prior subscribers, new ones work).
    let firedPostReset = false;
    w.on("begin", () => { firedPostReset = true; });
    w.observe(PROMPT, CTX);
    assert.equal(firedPostReset, true);
});

test("isNativePromptVisible exported helper covers the regex contract", () => {
    assert.equal(isVisible(PROMPT), true);
    assert.equal(isVisible("How are you doing in this session?"), true);
    assert.equal(isVisible("how are YOU doing in this session?"), true);  // case-insensitive
    assert.equal(isVisible("> How are you doing in this session?"), false);  // prompt-line skipped
    assert.equal(isVisible("nothing about feelings"), false);
    assert.equal(isVisible(""), false);
});
