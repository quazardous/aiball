// #1168 — le cache flags-context doit rendre exactement le recompute, et une
// invalidation force un rebuild. TTL borne toute staleness.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getCachedDecisionGate, getCachedActionable, invalidateFlagsCache } = await import("./flags-cache.js");

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

test("#1168: TTL — un cache plus vieux que 5s se rebuild sans invalidation", () => {
    invalidateFlagsCache();
    let builds = 0;
    const build = () => { builds++; return new Map(); };
    const t0 = 2_000_000;
    getCachedDecisionGate(build, t0);
    getCachedDecisionGate(build, t0 + 4_000);  // dans le TTL → hit
    assert.equal(builds, 1);
    getCachedDecisionGate(build, t0 + 6_000);  // hors TTL → rebuild
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
