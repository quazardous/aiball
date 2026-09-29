/**
 * #1059 — revive → NOT-AFK-10min seed.
 *
 * Proves the branch the kernel runs at boot: when we TAKE BACK a live
 * claude session via revive on a dead sock (CL_REATTACH=1 WITHOUT
 * CL_RESPAWN_STATE), the AFK snapshot is lost → seed a NOT-AFK-10min hold
 * (no surprise, auto-release after 10min) instead of `off` (autonomous).
 *
 * We combine the decision helper (`shouldSeedReattachHold`, real
 * `parseRespawnSnapshots`) with the real `AfkService` (same XState as the
 * kernel) → covers the decision+seed composition, not just the pieces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSeedReattachHold, serializeRespawnSnapshots } from "./respawn-state.js";
import { AfkService } from "./afk-service.js";

// The exact AFK snapshot a HEALTHY reload would pass on (XState persisted
// shape — only `afk !== undefined` matters for the decision).
const RAW_HEALTHY = serializeRespawnSnapshots({
    boot: { value: "sealed" },
    afk: { value: "wait_inf" },
    wake: { value: "idle" },
    typing: { value: "idle" },
    idle: { value: "no_turn" },
});

test("revive on dead sock (reattach, no snapshots) → seeds NOT-AFK-10min", () => {
    // cmdReload on a dead sock: CL_REATTACH=1 but no CL_RESPAWN_STATE.
    const decision = shouldSeedReattachHold(true, undefined);
    assert.equal(decision, true, "decision must fire when reattach + AFK snapshot lost");

    // The actual seed the kernel does.
    const svc = new AfkService();
    const expiry = 1_000_000 + 600_000;
    if (decision) svc.set10m(expiry);

    assert.equal(svc.getState(), "wait_10m", "AFK must land in wait_10m (NOT-AFK 10min)");
    assert.equal(svc.expiryMs(), expiry, "expiry must be the seeded +10min timestamp");
    svc.stop();
});

test("healthy reload (reattach + AFK snapshot present) → NO seed", () => {
    // cmdReload on a live sock: snapshots fetched, afk present → no seed
    // (the real AFK state will be restored via the respawn handoff, not overwritten).
    const decision = shouldSeedReattachHold(true, RAW_HEALTHY);
    assert.equal(decision, false, "a healthy reload restores AFK from snapshot, must not seed");
});

test("cold start (cmdStart, no reattach) → NO seed", () => {
    // cmdStart does NOT set CL_REATTACH → normal autonomous start.
    assert.equal(shouldSeedReattachHold(false, undefined), false);
    assert.equal(shouldSeedReattachHold(false, RAW_HEALTHY), false);
});

test("reattach with snapshots but AFK slice missing → seeds (defensive)", () => {
    // Snapshots passed on but without the `afk` key (partial corruption /
    // missing controller) = AFK state lost → we seed anyway.
    const raw = serializeRespawnSnapshots({ boot: { value: "sealed" } });
    assert.equal(shouldSeedReattachHold(true, raw), true);
});
