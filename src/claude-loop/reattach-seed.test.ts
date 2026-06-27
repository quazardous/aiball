/**
 * #1059 — revive → NOT-AFK-10min seed.
 *
 * Prouve la branche que le kernel exécute au boot : quand on REPREND une
 * session claude vivante via revive sur sock morte (CL_REATTACH=1 SANS
 * CL_RESPAWN_STATE), le snapshot AFK est perdu → seed un hold NOT-AFK-10min
 * (anti-surprise, auto-release après 10min) au lieu de `off` (autonome).
 *
 * On combine le helper de décision (`shouldSeedReattachHold`, vraie
 * `parseRespawnSnapshots`) avec la vraie `AfkService` (même XState que le
 * kernel) → couvre la composition décision+seed, pas seulement les briques.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSeedReattachHold, serializeRespawnSnapshots } from "./respawn-state.js";
import { AfkService } from "./afk-service.js";

// Le snapshot AFK exact qu'un reload SAIN transmettrait (forme XState
// persisted — seul `afk !== undefined` compte pour la décision).
const RAW_HEALTHY = serializeRespawnSnapshots({
    boot: { value: "sealed" },
    afk: { value: "wait_inf" },
    wake: { value: "idle" },
    typing: { value: "idle" },
    idle: { value: "no_turn" },
});

test("revive on dead sock (reattach, no snapshots) → seeds NOT-AFK-10min", () => {
    // cmdReload sock morte : CL_REATTACH=1 mais pas de CL_RESPAWN_STATE.
    const decision = shouldSeedReattachHold(true, undefined);
    assert.equal(decision, true, "decision must fire when reattach + AFK snapshot lost");

    // Le seed effectif que fait le kernel.
    const svc = new AfkService();
    const expiry = 1_000_000 + 600_000;
    if (decision) svc.set10m(expiry);

    assert.equal(svc.getState(), "wait_10m", "AFK must land in wait_10m (NOT-AFK 10min)");
    assert.equal(svc.expiryMs(), expiry, "expiry must be the seeded +10min timestamp");
    svc.stop();
});

test("healthy reload (reattach + AFK snapshot present) → NO seed", () => {
    // cmdReload sock vivante : snapshots fetchés, afk présent → pas de seed
    // (le vrai état AFK sera restauré via le respawn handoff, pas écrasé).
    const decision = shouldSeedReattachHold(true, RAW_HEALTHY);
    assert.equal(decision, false, "a healthy reload restores AFK from snapshot, must not seed");
});

test("cold start (cmdStart, no reattach) → NO seed", () => {
    // cmdStart ne pose PAS CL_REATTACH → démarrage autonome normal.
    assert.equal(shouldSeedReattachHold(false, undefined), false);
    assert.equal(shouldSeedReattachHold(false, RAW_HEALTHY), false);
});

test("reattach with snapshots but AFK slice missing → seeds (defensive)", () => {
    // Snapshots transmis mais sans la clé `afk` (corruption partielle /
    // controller absent) = état AFK perdu → on seed quand même.
    const raw = serializeRespawnSnapshots({ boot: { value: "sealed" } });
    assert.equal(shouldSeedReattachHold(true, raw), true);
});
