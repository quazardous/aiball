// BootMachine tests (#1009 — level+decay : MODULE_SEEN + seed, no push manager).
// Run: `npx tsx --test src/claude-loop/boot-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import {
    bootMachine,
    computeBootDeadline,
    liveBootModules,
    SEED_MODULE,
    DEFAULT_REMANENCE_MS,
} from "./boot-machine.js";

function mkActor(opts: { loopStartMs: number; bootMinMs?: number }) {
    return createActor(bootMachine, {
        input: { loopStartMs: opts.loopStartMs, bootMinMs: opts.bootMinMs ?? 30_000 },
    });
}

test("init : seed module 'boot' (remanence=bootMinMs) → deadline = loopStart + bootMinMs", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.deadlineMs, 1_030_000);
    assert.equal(actor.getSnapshot().value, "booting");
    assert.equal(SEED_MODULE in ctx.moduleSeen, true);
    assert.equal(ctx.moduleSeen[SEED_MODULE].remanenceMs, 30_000);
});

test("MODULE_SEEN : early transient stays under the floor → deadline = floor", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "MODULE_SEEN", name: "resume_picker", nowMs: 1_005_000 });
    // resume_picker falls at 1_005_000+10_000=1_015_000 < floor 1_030_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_030_000);
    assert.equal("resume_picker" in actor.getSnapshot().context.moduleSeen, true);
});

test("MODULE_SEEN : late transient extends the deadline past the floor", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "MODULE_SEEN", name: "compacting", nowMs: 1_025_000 });
    // falls at 1_035_000 > floor → deadline = 1_035_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_035_000);
});

test("MODULE_SEEN : re-signal slides the remanence window forward", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "MODULE_SEEN", name: "compacting", nowMs: 1_025_000 }); // → 1_035_000
    actor.send({ type: "MODULE_SEEN", name: "compacting", nowMs: 1_040_000 }); // → 1_050_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_050_000);
});

test("MODULE_SEEN : explicit remanenceMs honoured", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "MODULE_SEEN", name: "x", nowMs: 1_040_000, remanenceMs: 5_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_045_000);
});

test("computeBootDeadline / liveBootModules helpers", () => {
    const seen: Record<string, { lastSeenMs: number; remanenceMs: number }> = {
        [SEED_MODULE]: { lastSeenMs: 1_000_000, remanenceMs: 30_000 },   // falls 1_030_000
        compacting: { lastSeenMs: 1_025_000, remanenceMs: 10_000 },      // falls 1_035_000
    };
    assert.equal(computeBootDeadline(seen), 1_035_000);
    // at 1_032_000 : seed fallen, compacting live
    assert.deepEqual(liveBootModules(seen, 1_032_000), ["compacting"]);
    // at 1_005_000 : both live
    assert.deepEqual(liveBootModules(seen, 1_005_000).sort(), ["boot", "compacting"]);
    // at 1_040_000 : both fallen
    assert.deepEqual(liveBootModules(seen, 1_040_000), []);
});

test("DEADLINE_REACHED : booting → sealed", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(actor.getSnapshot().matches("sealed"), true);
    assert.equal(actor.getSnapshot().status, "active");
});


test("sealed terminal : later MODULE_SEEN are no-ops", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "DEADLINE_REACHED" });
    const before = Object.keys(actor.getSnapshot().context.moduleSeen).length;
    actor.send({ type: "MODULE_SEEN", name: "compacting", nowMs: 1_999_000 });
    assert.equal(Object.keys(actor.getSnapshot().context.moduleSeen).length, before);
    assert.equal("compacting" in actor.getSnapshot().context.moduleSeen, false);
});

test("emit boot:sealed (reason=deadline) on DEADLINE_REACHED", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const events: { reason: string }[] = [];
    actor.on("boot:sealed", (ev) => events.push(ev));
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(events[0].reason, "deadline");
});


// Scenarios — the decay model.

test("scenario : cold clean (seed only) → deadline = floor → seal at the floor", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_030_000);
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(actor.getSnapshot().matches("sealed"), true);
});

test("scenario : a module re-signalled then dropped → deadline = last signal + remanence", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    // resuming visible and re-signalled until 1_045_000, then nothing
    actor.send({ type: "MODULE_SEEN", name: "resuming", nowMs: 1_030_000 });
    actor.send({ type: "MODULE_SEEN", name: "resuming", nowMs: 1_045_000 });
    // falls at 1_055_000 ; the seed (1_030_000) has already fallen → deadline = 1_055_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_055_000);
    // at 1_056_000 no module is live any more (resuming not re-signalled)
    assert.deepEqual(liveBootModules(actor.getSnapshot().context.moduleSeen, 1_056_000), []);
});

test("snapshot observable : subscribe fires on transitions", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    let sawSealed = false;
    actor.subscribe((snap) => { if (snap.matches("sealed")) sawSealed = true; });
    actor.send({ type: "DEADLINE_REACHED" });
    assert.ok(sawSealed);
});

test("DEFAULT_REMANENCE_MS applied when remanenceMs is absent", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "MODULE_SEEN", name: "x", nowMs: 1_025_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_025_000 + DEFAULT_REMANENCE_MS);
});

// #848 — sealed.fresh → sealed.settled after 10s + emit loop:start

test("emit loop:start 10s after boot:sealed", async () => {
    const SETTLE_DELAY = 10_000;
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const events: { loopStartMs: number }[] = [];
    actor.on("loop:start", (ev) => events.push(ev));
    actor.send({ type: "DEADLINE_REACHED" });
    assert.deepEqual(actor.getSnapshot().value, { sealed: "fresh" });
    assert.equal(events.length, 0);
    await new Promise((r) => setTimeout(r, SETTLE_DELAY + 200));
    assert.deepEqual(actor.getSnapshot().value, { sealed: "settled" });
    assert.equal(events.length, 1);
    assert.equal(events[0].loopStartMs, 1_000_000);
});
