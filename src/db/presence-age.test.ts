/**
 * #1819 — the elapsed-time helper behind the presence facts.
 *
 * Two distinctions carry the whole design, and both fail quietly if wrong.
 *
 * `null` means "no human message on record", which is NOT "a long time ago".
 * An agent reading a missing value as a large age would conclude nobody is
 * around on a fresh project — the opposite of the truth, and unprompted.
 *
 * And a negative age must never escape. Callers compare `age < threshold`; a
 * clock skew between the daemon and a loop would otherwise make every such
 * test pass, silently reporting "just now" forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ageSeconds } from "./presence.js";

const NOW = Date.parse("2026-09-03T15:00:00.000Z");

test("elapsed seconds, rounded", () => {
    assert.equal(ageSeconds("2026-09-03T14:59:33.000Z", NOW), 27);
    assert.equal(ageSeconds("2026-09-03T14:00:00.000Z", NOW), 3600);
});

test("nothing on record reads as null, never as a large age", () => {
    assert.equal(ageSeconds(null, NOW), null);
    assert.equal(ageSeconds(undefined, NOW), null);
    assert.equal(ageSeconds("", NOW), null);
});

test("an unparseable timestamp reads as null rather than as NaN", () => {
    assert.equal(ageSeconds("not a date", NOW), null);
});

test("clock skew clamps to zero — a negative age would satisfy every threshold", () => {
    assert.equal(ageSeconds("2026-09-03T15:05:00.000Z", NOW), 0);
});
