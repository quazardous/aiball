// #1168 — the flags-context cache must return exactly the recompute, and an
// invalidation forces a rebuild. The ceiling (and each entry's own clock
// deadline, #2682) bounds any staleness.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getCachedDecisionGate, getCachedActionable, markDirty, setFlagsRepairers, peekActionable, CEILING_MS, clearFlagsCache: invalidateFlagsCache } =
    await import("./flags-cache.js");

test("#1168: getCachedDecisionGate serves the cache within the TTL, rebuilds after invalidation", () => {
    invalidateFlagsCache();
    let builds = 0;
    const build = () => { builds++; return new Map([[1, true]]); };
    const t0 = 1_000_000;
    getCachedDecisionGate(build, t0);
    getCachedDecisionGate(build, t0 + 100);   // cache hit
    assert.equal(builds, 1);
    invalidateFlagsCache();
    getCachedDecisionGate(build, t0 + 200);    // rebuild
    assert.equal(builds, 2);
});

test("#2682: the ceiling — an entry older than a minute rebuilds with no invalidation", () => {
    invalidateFlagsCache();
    let builds = 0;
    const build = () => { builds++; return new Map(); };
    const t0 = 2_000_000;
    getCachedDecisionGate(build, t0);
    getCachedDecisionGate(build, t0 + CEILING_MS - 1);  // inside → hit
    assert.equal(builds, 1);
    getCachedDecisionGate(build, t0 + CEILING_MS);      // reached → rebuild
    assert.equal(builds, 2);
});

test("#2682: an actionable entry expires at the deadline its value names", () => {
    invalidateFlagsCache();
    let builds = 0;
    const build = () => { builds++; return { deadline: 4_000_500 }; };
    const deadlineOf = (v: { deadline: number }) => v.deadline;
    getCachedActionable("A", build, 4_000_000, deadlineOf);
    getCachedActionable("A", build, 4_000_499, deadlineOf); // before → hit
    assert.equal(builds, 1);
    getCachedActionable("A", build, 4_000_500, deadlineOf); // due → rebuild
    assert.equal(builds, 2);
});

test("#2682: a repair brings the expiry forward, never back", () => {
    invalidateFlagsCache();
    let builds = 0;
    const build = () => { builds++; return {}; };
    const t0 = 5_000_000;
    let deadline = t0 + 300;
    setFlagsRepairers({ actionable: () => deadline, decisionGate: () => {} });
    getCachedActionable("A", build, t0);
    markDirty([1], t0 + 100);                                  // a claim just taken
    getCachedActionable("A", build, t0 + 150);
    deadline = t0 + 50_000;
    markDirty([1], t0 + 200);                                  // later deadline: ignored
    getCachedActionable("A", build, t0 + 299);
    assert.equal(builds, 1);
    getCachedActionable("A", build, t0 + 300);
    assert.equal(builds, 2);
});

test("a write repairs nothing: each entry is repaired at its own next read, once, for every ticket written since", () => {
    invalidateFlagsCache();
    const repaired: [string | undefined, number[]][] = [];
    let gateRepairs = 0;
    setFlagsRepairers({
        actionable: (consumer, _val, ids) => { repaired.push([consumer, [...ids].sort()]); return null; },
        decisionGate: () => { gateRepairs++; },
    });
    const t0 = 6_000_000;
    getCachedActionable("A", () => ({}), t0);
    getCachedActionable("B", () => ({}), t0);
    getCachedDecisionGate(() => new Map(), t0);
    markDirty([7], t0 + 1);
    markDirty([7, 9], t0 + 2);
    assert.deepEqual(repaired, [], "the writes ran no repair");
    assert.equal(gateRepairs, 0);
    peekActionable("A", t0 + 3);
    assert.deepEqual(repaired, [["A", [7, 9]]], "A's read repaired A, for both writes at once");
    getCachedActionable("A", () => ({}), t0 + 4);
    assert.equal(repaired.length, 1, "a clean entry is not repaired again");
    getCachedDecisionGate(() => new Map(), t0 + 5);
    assert.equal(gateRepairs, 1);
    getCachedActionable("B", () => ({}), t0 + 6);
    assert.deepEqual(repaired[1], ["B", [7, 9]]);
});

test("an entry with too many tickets to repair is rebuilt instead", () => {
    invalidateFlagsCache();
    let repairs = 0;
    let builds = 0;
    setFlagsRepairers({ actionable: () => { repairs++; return null; }, decisionGate: () => {} });
    const t0 = 7_000_000;
    getCachedActionable("A", () => { builds++; return {}; }, t0);
    markDirty(Array.from({ length: 201 }, (_, i) => i + 1), t0 + 1);
    getCachedActionable("A", () => { builds++; return {}; }, t0 + 2);
    assert.equal(builds, 2);
    assert.equal(repairs, 0);
});

test("#1168: actionable cached PER consumer (distinct keys)", () => {
    invalidateFlagsCache();
    const seen: string[] = [];
    const build = (c: string) => () => { seen.push(c); return { openIds: new Set(), actionableIds: new Set() }; };
    const t0 = 3_000_000;
    getCachedActionable("A", build("A"), t0);
    getCachedActionable("B", build("B"), t0);   // different key → build
    getCachedActionable("A", build("A"), t0 + 100); // A cached → no build
    assert.deepEqual(seen, ["A", "B"]);
});
