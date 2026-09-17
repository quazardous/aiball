// #1168 — le cache flags-context doit rendre exactement le recompute, et une
// invalidation force un rebuild. The ceiling (and each entry's own clock
// deadline, #2682) bounds any staleness.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getCachedDecisionGate, getCachedActionable, repairEntries, CEILING_MS, clearFlagsCache: invalidateFlagsCache } =
    await import("./flags-cache.js");

test("#1168: getCachedDecisionGate sert le cache dans le TTL, rebuild après invalidation", () => {
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
    getCachedActionable("A", build, t0);
    repairEntries(() => t0 + 300, () => {}, t0 + 100);        // a claim just taken
    repairEntries(() => t0 + 50_000, () => {}, t0 + 200);     // later deadline: ignored
    getCachedActionable("A", build, t0 + 299);
    assert.equal(builds, 1);
    getCachedActionable("A", build, t0 + 300);
    assert.equal(builds, 2);
});

test("#1168: actionable caché PAR consumer (clés distinctes)", () => {
    invalidateFlagsCache();
    const seen: string[] = [];
    const build = (c: string) => () => { seen.push(c); return { openIds: new Set(), actionableIds: new Set() }; };
    const t0 = 3_000_000;
    getCachedActionable("A", build("A"), t0);
    getCachedActionable("B", build("B"), t0);   // clé différente → build
    getCachedActionable("A", build("A"), t0 + 100); // A en cache → pas de build
    assert.deepEqual(seen, ["A", "B"]);
});
