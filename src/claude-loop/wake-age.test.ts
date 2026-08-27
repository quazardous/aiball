/**
 * #1820 — the age marker a wake carries.
 *
 * The threshold is the design, not a tuning knob: if the marker rendered on
 * every wake it would read "0 hours ago" on fresh ones, become decoration,
 * and stop being read. Emitting nothing while the event is fresh is what
 * makes its presence mean "this one waited" — so the empty cases below are
 * the load-bearing assertions, not the formatted ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatWakeAge, WAKE_AGE_MIN_MS } from "./state.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test("nothing renders while the event is fresh", () => {
    assert.equal(formatWakeAge(ago(0), NOW), "");
    assert.equal(formatWakeAge(ago(60_000), NOW), "");
    assert.equal(formatWakeAge(ago(WAKE_AGE_MIN_MS - 1), NOW), "");
});

test("the marker appears exactly at the threshold", () => {
    assert.equal(formatWakeAge(ago(WAKE_AGE_MIN_MS), NOW), "1 hour ago");
});

test("hours, then days, singular and plural", () => {
    assert.equal(formatWakeAge(ago(5 * 3_600_000), NOW), "5 hours ago");
    assert.equal(formatWakeAge(ago(23 * 3_600_000), NOW), "23 hours ago");
    assert.equal(formatWakeAge(ago(24 * 3_600_000), NOW), "1 day ago");
    assert.equal(formatWakeAge(ago(50 * 3_600_000), NOW), "2 days ago");
});

test("the two cases that motivated this: a week-old decision and a week-old question", () => {
    // Both were measured on 2026-08-20 and reached the agent on 2026-08-27.
    const aWeek = Date.parse("2026-08-20T11:42:07Z");
    assert.equal(formatWakeAge(new Date(aWeek).toISOString(), NOW), "7 days ago");
});

test("a missing or unparseable timestamp renders nothing, never a wrong age", () => {
    assert.equal(formatWakeAge(null, NOW), "");
    assert.equal(formatWakeAge(undefined, NOW), "");
    assert.equal(formatWakeAge("", NOW), "");
    assert.equal(formatWakeAge("not a date", NOW), "");
});

test("clock skew: an event dated in the future renders nothing", () => {
    // The daemon and the loop can disagree; a negative age must not surface
    // as "-1 hours ago" or as a huge day count.
    assert.equal(formatWakeAge(new Date(NOW + 3_600_000).toISOString(), NOW), "");
});
