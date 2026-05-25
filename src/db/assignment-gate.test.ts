// #418 — pure assignment-exclusion gate. node:test + tsx (zero deps).
// Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAssignmentLive, isAssignedAway, isHeldByOther, claimsToAutoRelease } from "./assignment-gate.js";

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

// #436: isHeldByOther — claim (transient) OR assignment (persistent) by another.
test("isHeldByOther: a LIVE claim by another → away", () => {
    assert.equal(isHeldByOther(null, OTHER, iso(0), C, NOW, WINDOW), true);
    assert.equal(isHeldByOther(null, OTHER, iso(WINDOW - 1000), C, NOW, WINDOW), true);
});
test("isHeldByOther: an EXPIRED claim by another (no assignment) → not away", () => {
    assert.equal(isHeldByOther(null, OTHER, iso(WINDOW + 1000), C, NOW, WINDOW), false);
});
test("isHeldByOther: an assignment to another is PERSISTENT (no expiry) → away", () => {
    assert.equal(isHeldByOther(OTHER, null, null, C, NOW, WINDOW), true);
});
test("isHeldByOther: held by ME (claim or assignment) → not away", () => {
    assert.equal(isHeldByOther(C, null, null, C, NOW, WINDOW), false);
    assert.equal(isHeldByOther(null, C, iso(0), C, NOW, WINDOW), false);
});
test("isHeldByOther: unheld → not away", () => {
    assert.equal(isHeldByOther(null, null, null, C, NOW, WINDOW), false);
});
test("isHeldByOther: assignment to me + live claim by other → away (the claim wins)", () => {
    assert.equal(isHeldByOther(C, OTHER, iso(0), C, NOW, WINDOW), true);
});

// #439 one-focus — claimsToAutoRelease.
const claimedMs = (msAgo: number) => NOW - msAgo;

test("claimsToAutoRelease: a bare live pickup (never commented) → released", () => {
    const claims = [{ id: 10, claimedAt: iso(60_000) }]; // claimed 1min ago
    assert.deepEqual(
        claimsToAutoRelease(claims, new Map(), /*keep*/ 99, NOW, WINDOW),
        [10],
    );
});

test("claimsToAutoRelease: worked since claim (self comment after claimed_at) → kept", () => {
    const claims = [{ id: 10, claimedAt: iso(60_000) }];
    const acted = new Map([[10, claimedMs(30_000)]]); // commented 30s ago, AFTER claim
    assert.deepEqual(claimsToAutoRelease(claims, acted, 99, NOW, WINDOW), []);
});

test("claimsToAutoRelease: the ticket being engaged (keepId) is never released", () => {
    const claims = [{ id: 10, claimedAt: iso(60_000) }];
    assert.deepEqual(claimsToAutoRelease(claims, new Map(), /*keep*/ 10, NOW, WINDOW), []);
});

test("claimsToAutoRelease: an expired claim → not released (already out of pools)", () => {
    const claims = [{ id: 10, claimedAt: iso(WINDOW + 1000) }];
    assert.deepEqual(claimsToAutoRelease(claims, new Map(), 99, NOW, WINDOW), []);
});

test("claimsToAutoRelease: comment BEFORE claim (re-claimed, untouched since) → released", () => {
    const claims = [{ id: 10, claimedAt: iso(60_000) }]; // claimed 1min ago
    const acted = new Map([[10, claimedMs(120_000)]]); // last comment 2min ago, BEFORE claim
    assert.deepEqual(claimsToAutoRelease(claims, acted, 99, NOW, WINDOW), [10]);
});

test("claimsToAutoRelease: mixed set → only bare live non-keep claims drop", () => {
    const claims = [
        { id: 10, claimedAt: iso(60_000) },             // bare live → drop
        { id: 11, claimedAt: iso(60_000) },             // worked → keep
        { id: 12, claimedAt: iso(WINDOW + 1000) },      // expired → keep
        { id: 13, claimedAt: iso(60_000) },             // keepId → keep
        { id: 14, claimedAt: null },                    // no timestamp → not live → keep
    ];
    const acted = new Map([[11, claimedMs(10_000)]]);   // worked 11 after claim
    assert.deepEqual(claimsToAutoRelease(claims, acted, /*keep*/ 13, NOW, WINDOW), [10]);
});
