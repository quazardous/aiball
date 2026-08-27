/**
 * #1820 — the time marker a wake carries.
 *
 * The threshold is the design, not a tuning knob: if the marker rendered on
 * every wake it would read "0 hours ago" on fresh ones, become decoration,
 * and stop being read. Emitting nothing while the event is fresh is what
 * makes its presence mean "this one waited" — so the empty cases below are
 * the load-bearing assertions, not the formatted ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatWakeStamp, WAKE_AGE_MIN_MS } from "./state.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test("nothing renders while the event is fresh", () => {
    assert.equal(formatWakeStamp(ago(0), NOW), "");
    assert.equal(formatWakeStamp(ago(60_000), NOW), "");
    assert.equal(formatWakeStamp(ago(WAKE_AGE_MIN_MS - 1), NOW), "");
});

test("the marker appears exactly at the threshold", () => {
    assert.match(formatWakeStamp(ago(WAKE_AGE_MIN_MS), NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("the stamp is the event's own wall-clock time, not the wake's", () => {
    // Rendered in local time: a loop runs on one machine for one operator,
    // so the stamp must match the day he remembers.
    const at = new Date(2026, 7, 20, 11, 42, 7); // 2026-08-20 11:42 local
    assert.equal(formatWakeStamp(at.toISOString(), NOW), "2026-08-20 11:42");
});

test("single-digit month, day, hour and minute are zero-padded", () => {
    const at = new Date(2026, 0, 3, 4, 5, 0); // 2026-01-03 04:05 local
    const now = at.getTime() + 48 * 3_600_000;
    assert.equal(formatWakeStamp(at.toISOString(), now), "2026-01-03 04:05");
});

test("a missing or unparseable timestamp renders nothing, never a wrong age", () => {
    assert.equal(formatWakeStamp(null, NOW), "");
    assert.equal(formatWakeStamp(undefined, NOW), "");
    assert.equal(formatWakeStamp("", NOW), "");
    assert.equal(formatWakeStamp("not a date", NOW), "");
});

test("clock skew: an event dated in the future renders nothing", () => {
    // The daemon and the loop can disagree; a negative age must not surface
    // as "-1 hours ago" or as a huge day count.
    assert.equal(formatWakeStamp(new Date(NOW + 3_600_000).toISOString(), NOW), "");
});
