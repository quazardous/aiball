// #1166 — a snapshot persisted in a timer-only state (cooldown/inFlight) must
// NEVER be restored: XState does not re-arm the after() when restoring a
// persisted snapshot → the machine stayed in `cooldown` forever (skybot stuck,
// every drain refused `wakeMachine state=cooldown` every 10 s). The guard
// lives in getWakeService: snapshot in inFlight/cooldown → dropped → idle.
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

// NB: a FRESH machine starts in `gated` (BOOT_READY → idle). So the fix's
// criterion is not isIdle but "NOT being in cooldown/inFlight":
// dropped = nominal boot (gated), restored-idle = idle.
test("#1166: pending snapshot in cooldown → dropped (nominal boot in gated, no prison)", (t) => {
    const svc = restoreFrom("cooldown");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "gated");
});

test("#1166: pending snapshot in inFlight → dropped too", (t) => {
    const svc = restoreFrom("inFlight");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "gated");
});

test("#1166: pending snapshot in idle → restored as is (no regression)", (t) => {
    const svc = restoreFrom("idle");
    t.after(() => { setPendingRespawnSnapshots(null); resetWakeServiceForTests(); });
    assert.equal(svc.getActor().getSnapshot().value, "idle");
    assert.equal(svc.isIdle(), true);
});

test("#1166: proof of the underlying bug — a direct restore in cooldown is a prison", (t) => {
    // Without the guard: createActor(snapshot=cooldown) stays in cooldown (the
    // after() are not re-armed by XState on restore). This is the
    // behaviour seen on skybot (drains refused in a loop).
    setPendingRespawnSnapshots(null);
    const actor = createActor(wakeMachine, { input: {}, snapshot: mkSnap("cooldown") as never }).start();
    t.after(() => actor.stop());
    assert.equal(actor.getSnapshot().value, "cooldown");
});
