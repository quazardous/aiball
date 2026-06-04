// Pure tests for the wake-injection coalesce decision (anti-burst).
// node:test, injected clock, no fs. Counter model — any trigger within
// the coalesce window collapses to the prior fire, regardless of phrase
// content. The phrase is persisted as a diagnostic of "what fired last".
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeWakeInjection } from "./state.js";

const NOW = Date.parse("2026-05-24T21:14:06.955Z");
const W = 5000;
const at = (deltaMs: number, phrase: string) =>
    new Date(NOW + deltaMs).toISOString() + "\n" + phrase;

test("no previous marker → inject and persist", () => {
    const r = dedupeWakeInjection(null, "wake A", NOW, W);
    assert.equal(r.skip, false);
    assert.equal(r.write, new Date(NOW).toISOString() + "\n" + "wake A");
});

test("same phrase within window → SKIP (the #409 duplicate)", () => {
    const prev = at(-1000, "aiball ticket #407 waits for your answer — comment #kysztg.");
    const r = dedupeWakeInjection(prev, "aiball ticket #407 waits for your answer — comment #kysztg.", NOW, W);
    assert.equal(r.skip, true);
    assert.equal(r.write, null);
});

test("same phrase past the window → inject again", () => {
    const prev = at(-60000, "wake A"); // 60s old, well past the window
    const r = dedupeWakeInjection(prev, "wake A", NOW, W);
    assert.equal(r.skip, false);
    assert.equal(r.write, new Date(NOW).toISOString() + "\n" + "wake A");
});

test("different phrase within window → SKIP (counter model, #623)", () => {
    // #623 david 7fh9rk : counter not queue — any trigger within the
    // window collapses regardless of phrase content.
    const prev = at(-1000, "wake A");
    const r = dedupeWakeInjection(prev, "wake B", NOW, W);
    assert.equal(r.skip, true);
});

test("windowMs <= 0 disables the dedup (always inject)", () => {
    const prev = at(-100, "wake A");
    assert.equal(dedupeWakeInjection(prev, "wake A", NOW, 0).skip, false);
    assert.equal(dedupeWakeInjection(prev, "wake A", NOW, -1).skip, false);
});

test("malformed marker (no newline) → fail open, inject", () => {
    const r = dedupeWakeInjection("garbage-no-newline", "wake A", NOW, W);
    assert.equal(r.skip, false);
});

test("future timestamp (negative age, clock skew) → do not skip", () => {
    const prev = at(+1000, "wake A");
    const r = dedupeWakeInjection(prev, "wake A", NOW, W);
    assert.equal(r.skip, false);
});

test("round-trip: a persisted marker dedups the next identical inject", () => {
    const first = dedupeWakeInjection(null, "multi\nline\nwake", NOW, W);
    assert.equal(first.skip, false);
    assert.notEqual(first.write, null);
    // sibling site fires 500ms later with the SAME (multiline) phrase
    const second = dedupeWakeInjection(first.write, "multi\nline\nwake", NOW + 500, W);
    assert.equal(second.skip, true);
});
