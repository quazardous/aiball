// #418 — pure assignment-exclusion gate. node:test + tsx (zero deps).
// Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAssignmentLive, isAssignedAway } from "./assignment-gate.js";

const C = "claude-aiball-dev"; // the consumer asking "what's in my court?"
const OTHER = "skybot";
const WINDOW = 4 * 3600 * 1000; // 4h in ms
const NOW = Date.parse("2026-05-25T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("isAssignmentLive: within window true, at/after boundary false", () => {
    assert.equal(isAssignmentLive(iso(0), NOW, WINDOW), true); // just now
    assert.equal(isAssignmentLive(iso(WINDOW - 1000), NOW, WINDOW), true); // 1s before expiry
    assert.equal(isAssignmentLive(iso(WINDOW), NOW, WINDOW), false); // exact boundary: now−at == window, not <
    assert.equal(isAssignmentLive(iso(WINDOW + 1000), NOW, WINDOW), false); // 1s after expiry
    assert.equal(isAssignmentLive(null, NOW, WINDOW), false);
    assert.equal(isAssignmentLive(undefined, NOW, WINDOW), false);
    assert.equal(isAssignmentLive("not-a-date", NOW, WINDOW), false);
});

test("isAssignedAway: live-assigned to someone else → out of my pool", () => {
    assert.equal(isAssignedAway(OTHER, iso(0), C, NOW, WINDOW), true);
});

test("isAssignedAway: assigned to me → never away (I keep seeing it)", () => {
    assert.equal(isAssignedAway(C, iso(0), C, NOW, WINDOW), false);
});

test("isAssignedAway: unassigned → not away (shared pool)", () => {
    assert.equal(isAssignedAway(null, null, C, NOW, WINDOW), false);
    assert.equal(isAssignedAway(undefined, iso(0), C, NOW, WINDOW), false);
});

test("isAssignedAway: expired claim by other → back in the pool (not away)", () => {
    assert.equal(isAssignedAway(OTHER, iso(WINDOW + 1000), C, NOW, WINDOW), false);
});

test("isAssignedAway: assignee set but no timestamp → not live → not away", () => {
    assert.equal(isAssignedAway(OTHER, null, C, NOW, WINDOW), false);
});
