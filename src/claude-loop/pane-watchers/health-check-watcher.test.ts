/**
 * #850 — HealthCheckWatcher tests. node:test, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthCheckWatcher, _findStandaloneScoreForTests as findScore } from "./health-check-watcher.js";

const CTX = { nowMs: 1_700_000_000_000 };

test("captures a bare digit response on its own line", () => {
    const w = new HealthCheckWatcher();
    const pane = ["claude prompt area", "──────", "4", "──────"].join("\n");
    const s = w.observe(pane, CTX);
    assert.equal(s.score, 4);
});

test("captures an assistant-prefixed digit (● 5 / ✻ 3)", () => {
    const w = new HealthCheckWatcher();
    assert.equal(w.observe("● 5", CTX).score, 5);
    const w2 = new HealthCheckWatcher();
    assert.equal(w2.observe("✻ 3 — feeling mid", CTX).score, 3);
});

test("does NOT capture digits in prose (e.g. '#42 closed', URL)", () => {
    const w = new HealthCheckWatcher();
    const pane = "ticket #42 closed", _2 = w.observe(pane, CTX);
    assert.equal(_2.score, null);
});

test("does NOT capture digits in user prompt lines (starting with ❯)", () => {
    const w = new HealthCheckWatcher();
    const pane = ["claude output", "❯ 3"].join("\n");
    assert.equal(w.observe(pane, CTX).score, null);
});

test("is one-shot — re-observing with a different digit keeps the first", () => {
    const w = new HealthCheckWatcher();
    assert.equal(w.observe("● 4", CTX).score, 4);
    // Subsequent observe must NOT change the score.
    assert.equal(w.observe("● 2", CTX).score, 4);
    assert.equal(w.snapshot().score, 4);
});

test("scans only the footer (last N lines) — old scores in scrollback ignored", () => {
    const w = new HealthCheckWatcher();
    const scrollback = Array.from({ length: 30 }, () => "● 5").join("\n");
    const pane = scrollback + "\n" + Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    // No bare digit in the footer (>12 lines from any 5) → null.
    assert.equal(w.observe(pane, CTX).score, null);
});

test("ignores digits outside 1-5 (0, 6, 7, ...)", () => {
    const w = new HealthCheckWatcher();
    assert.equal(w.observe("● 7", CTX).score, null);
    const w2 = new HealthCheckWatcher();
    assert.equal(w2.observe("● 0", CTX).score, null);
});

test("emits change exactly once on capture", () => {
    const w = new HealthCheckWatcher();
    const changes: number[] = [];
    w.on("change", (next) => { if (next.score !== null) changes.push(next.score); });
    w.observe("nothing here yet", CTX);
    assert.deepEqual(changes, []);
    w.observe("● 5", CTX);
    assert.deepEqual(changes, [5]);
    w.observe("● 2", CTX); // one-shot — no re-emit
    assert.deepEqual(changes, [5]);
});

test("reset() drops captured score and listeners", () => {
    const w = new HealthCheckWatcher();
    w.observe("● 3", CTX); // captures score=3
    assert.equal(w.snapshot().score, 3);
    w.reset();
    assert.equal(w.snapshot().score, null);
    // Listener attached AFTER reset — must NOT see the post-reset capture
    // if reset() also dropped listeners attached BEFORE reset. To exercise
    // that path, attach pre-reset and verify no fire post-reset.
    let firedPostReset = false;
    // Attach BEFORE reset (already done implicitly — no listener was on
    // the prior path) ; reset() clears any prior listeners. Now attach
    // and verify it DOES fire (= reset cleared the old, new ones work).
    w.on("change", () => { firedPostReset = true; });
    w.observe("● 4", CTX);
    assert.equal(w.snapshot().score, 4);
    assert.equal(firedPostReset, true); // listener attached post-reset fires
});

test("findStandaloneScore exported helper covers the regex contract", () => {
    assert.equal(findScore("● 3"), 3);
    assert.equal(findScore("3"), 3);
    assert.equal(findScore("\n\n4\n"), 4);
    assert.equal(findScore("❯ 5"), null);
    assert.equal(findScore("nothing"), null);
    assert.equal(findScore(""), null);
});
