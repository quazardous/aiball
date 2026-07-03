// #1165 — un snapshot persisté en état timer-only (cooldown/inFlight) ne doit
// JAMAIS être restauré : XState ne ré-arme pas les after() au restore d'un
// snapshot persisté → la machine restait en `cooldown` à vie (skybot bloqué,
// chaque drain refusé `wakeMachine state=cooldown` toutes les 10 s). La garde
// vit dans getWakeService : snapshot en inFlight/cooldown → droppé → idle.
// Run: `npx tsx --test src/claude-loop/wake-service.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clearWakeServiceSingletonForTests,
    getWakeService,
    resetWakeServiceForTests,
} from "./wake-service.js";
import { setPendingRespawnSnapshots } from "./respawn-state.js";
import { createActor } from "xstate";
import { wakeMachine } from "./wake-machine.js";

function mkSnap(value: string): unknown {
    return {
        status: "active",
        value,
        context: { wakeInFlightAtMs: null, inFlightTtlMs: 30_000, coalesceWindowMs: 10_000 },
        children: {},
        historyValue: {},
    };
}

function restoreFrom(value: string) {
    setPendingRespawnSnapshots({ wake: mkSnap(value) } as never);
    clearWakeServiceSingletonForTests();
    return getWakeService();
}

// NB : une machine FRAÎCHE démarre en `gated` (BOOT_READY → idle). Le
// critère du fix n'est donc pas isIdle mais « ne PAS être en cooldown/
// inFlight » : droppé = boot nominal (gated), restauré-idle = idle.
test("#1165: pending snapshot en cooldown → droppé (boot nominal en gated, pas de prison)", (t) => {
    const svc = restoreFrom("cooldown");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "gated");
});

test("#1165: pending snapshot en inFlight → droppé aussi", (t) => {
    const svc = restoreFrom("inFlight");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "gated");
});

test("#1165: pending snapshot en idle → restauré tel quel (pas de régression)", (t) => {
    const svc = restoreFrom("idle");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "idle");
    assert.equal(svc.isIdle(), true);
});

test("#1165: preuve du bug sous-jacent — un restore direct en cooldown est une prison", (t) => {
    // Sans la garde : createActor(snapshot=cooldown) reste en cooldown (les
    // after() ne sont pas ré-armés par XState au restore). C'est le
    // comportement observé sur skybot (drains refusés en boucle).
    setPendingRespawnSnapshots(null);
    const actor = createActor(wakeMachine, { input: {}, snapshot: mkSnap("cooldown") as never }).start();
    t.after(() => actor.stop());
    assert.equal(actor.getSnapshot().value, "cooldown");
});
