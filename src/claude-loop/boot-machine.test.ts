// BootMachine tests (#883 — module-based vocabulary, manager-driven push).
// Run: `npx tsx --test src/claude-loop/boot-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { bootMachine } from "./boot-machine.js";

function mkActor(opts: { loopStartMs: number; bootMinMs?: number; tunnelMs?: number }) {
    return createActor(bootMachine, {
        input: {
            loopStartMs: opts.loopStartMs,
            bootMinMs: opts.bootMinMs ?? 30_000,
            tunnelMs: opts.tunnelMs ?? 10_000,
        },
    });
}

test("init : deadline = loopStartMs + bootMinMs (floor)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.deadlineMs, 1_030_000);
    assert.equal(actor.getSnapshot().value, "booting");
    assert.equal(ctx.activeModules.size, 0);
});

test("MODULE_STARTED : add to activeModules ; deadline unchanged (push manager owns push)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const deadlineBefore = actor.getSnapshot().context.deadlineMs;
    actor.send({ type: "MODULE_STARTED", name: "resume_picker" });
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.activeModules.has("resume_picker"), true);
    assert.equal(ctx.activeModules.size, 1);
    assert.equal(ctx.deadlineMs, deadlineBefore);
});

test("PUSH avec activeModules > 0 : deadline = max(deadline, nowMs + tunnel)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "compacting" });
    actor.send({ type: "PUSH", nowMs: 1_025_000 });
    // max(1_030_000 floor, 1_025_000+10_000) = max(1_030_000, 1_035_000) = 1_035_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_035_000);
});

test("PUSH avec activeModules vide : no-op (deadline unchanged)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const before = actor.getSnapshot().context.deadlineMs;
    actor.send({ type: "PUSH", nowMs: 1_025_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, before);
});

test("PUSH ne raccourcit jamais (max)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "compacting" });
    actor.send({ type: "PUSH", nowMs: 1_025_000 });          // → 1_035_000
    actor.send({ type: "PUSH", nowMs: 1_020_000 });          // older — should not shorten
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_035_000);
});

test("MODULE_ENDED : remove from set, deadline unchanged (tunnel = last push reste)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "compacting" });
    actor.send({ type: "PUSH", nowMs: 1_025_000 });
    actor.send({ type: "MODULE_ENDED", name: "compacting" });
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.activeModules.size, 0);
    assert.equal(ctx.deadlineMs, 1_035_000);
});

test("DEADLINE_REACHED : booting → sealed", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(actor.getSnapshot().value, "sealed");
    assert.equal(actor.getSnapshot().status, "done");
});

test("HOOK_SEAL : booting → sealed", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "HOOK_SEAL" });
    assert.equal(actor.getSnapshot().value, "sealed");
});

test("sealed terminal : MODULE_STARTED suivants no-op", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "HOOK_SEAL" });
    actor.send({ type: "MODULE_STARTED", name: "compacting" });
    assert.equal(actor.getSnapshot().context.activeModules.size, 0);
});

// Locus events.

test("emit boot:sealed (reason=deadline) sur DEADLINE_REACHED", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const events: { reason: string }[] = [];
    actor.on("boot:sealed", (ev) => events.push(ev));
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(events[0].reason, "deadline");
});

test("emit boot:sealed (reason=hook) sur HOOK_SEAL", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const events: { reason: string }[] = [];
    actor.on("boot:sealed", (ev) => events.push(ev));
    actor.send({ type: "HOOK_SEAL" });
    assert.equal(events[0].reason, "hook");
});

// Scenario tests (#883).

test("scénario : cold clean (no module) → deadline reste floor → seal au floor", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_030_000);
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(actor.getSnapshot().value, "sealed");
});

test("scénario : resume picker only → seal à dernier_push + tunnel", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "resume_picker" });
    // Manager push toutes les secondes pendant que module actif.
    actor.send({ type: "PUSH", nowMs: 1_010_000 });   // → max(30s, 1_020_000) = 1_030_000
    actor.send({ type: "PUSH", nowMs: 1_015_000 });   // → max(1_030_000, 1_025_000) = 1_030_000
    actor.send({ type: "PUSH", nowMs: 1_022_000 });   // → 1_032_000
    actor.send({ type: "MODULE_ENDED", name: "resume_picker" });
    // Manager arrête. deadline reste à 1_032_000. Pump fire à T=1_032_000 → seal.
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_032_000);
});

test("scénario : combo picker → resuming → compact_confirm → compacting → seal après dernier END", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "resume_picker" });
    actor.send({ type: "PUSH", nowMs: 1_005_000 });
    actor.send({ type: "MODULE_STARTED", name: "resuming" });
    actor.send({ type: "MODULE_ENDED", name: "resume_picker" });
    actor.send({ type: "PUSH", nowMs: 1_010_000 });
    actor.send({ type: "MODULE_STARTED", name: "compact_confirm" });
    actor.send({ type: "MODULE_ENDED", name: "resuming" });
    actor.send({ type: "PUSH", nowMs: 1_015_000 });
    actor.send({ type: "MODULE_STARTED", name: "compacting" });
    actor.send({ type: "MODULE_ENDED", name: "compact_confirm" });
    actor.send({ type: "PUSH", nowMs: 1_040_000 });   // compacting toujours actif
    actor.send({ type: "MODULE_ENDED", name: "compacting" });
    // Manager arrête. deadline = 1_050_000 (= dernier push 1_040_000 + tunnel 10_000).
    assert.equal(actor.getSnapshot().context.activeModules.size, 0);
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_050_000);
});

test("scénario : 2 modules simultanés → manager pushe tant qu'au moins 1 actif", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, tunnelMs: 10_000 }).start();
    actor.send({ type: "MODULE_STARTED", name: "resume_picker" });
    actor.send({ type: "MODULE_STARTED", name: "resuming" });
    actor.send({ type: "PUSH", nowMs: 1_010_000 });
    actor.send({ type: "MODULE_ENDED", name: "resume_picker" });
    // resuming toujours actif → manager pushe encore
    actor.send({ type: "PUSH", nowMs: 1_020_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_030_000);
    actor.send({ type: "MODULE_ENDED", name: "resuming" });
    // Tous deux off → manager arrête.
    assert.equal(actor.getSnapshot().context.activeModules.size, 0);
});

test("snapshot observable : subscribe fires sur transitions", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const states: string[] = [];
    actor.subscribe((snap) => states.push(String(snap.value)));
    actor.send({ type: "HOOK_SEAL" });
    assert.ok(states.includes("sealed"));
});
