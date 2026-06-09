// #872 / #870 POC — XState BootMachine tests.
// Run: `npx tsx --test src/claude-loop/boot-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { bootMachine } from "./boot-machine.js";

function mkActor(opts: { loopStartMs: number; bootMinMs?: number; pushExtensionMs?: number }) {
    return createActor(bootMachine, {
        input: {
            loopStartMs: opts.loopStartMs,
            bootMinMs: opts.bootMinMs ?? 30_000,
            pushExtensionMs: opts.pushExtensionMs ?? 10_000,
        },
    });
}

test("init : deadline = loopStartMs + bootMinMs", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.deadlineMs, 1_030_000);
    assert.equal(actor.getSnapshot().value, "booting");
});

test("WATCHER_TICK : push deadline to now + pushExtensionMs si > current", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    actor.send({ type: "WATCHER_TICK", nowMs: 1_025_000 }); // now+10s = 1_035_000 > 1_030_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_035_000);
});

test("WATCHER_TICK : ne raccourcit pas si deadline déjà > now+10s", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    actor.send({ type: "WATCHER_TICK", nowMs: 1_010_000 }); // now+10s = 1_020_000 < 1_030_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_030_000);
});

test("WATCHER_TICK : multiples pushes étendent le deadline progressivement", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000 }).start();
    actor.send({ type: "WATCHER_TICK", nowMs: 1_025_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_035_000);
    actor.send({ type: "WATCHER_TICK", nowMs: 1_030_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_040_000);
    actor.send({ type: "WATCHER_TICK", nowMs: 1_040_000 });
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_050_000);
});

test("DEADLINE_REACHED : transition booting → sealed", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "DEADLINE_REACHED" });
    assert.equal(actor.getSnapshot().value, "sealed");
    assert.equal(actor.getSnapshot().status, "done");
});

test("HOOK_SEAL : transition booting → sealed (= raccourci hook)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "HOOK_SEAL" });
    assert.equal(actor.getSnapshot().value, "sealed");
});

test("sealed : terminal, WATCHER_TICK suivants no-op (= ne re-ouvre pas la boot phase)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    actor.send({ type: "HOOK_SEAL" });
    const deadlineBefore = actor.getSnapshot().context.deadlineMs;
    actor.send({ type: "WATCHER_TICK", nowMs: 9_999_999 });
    assert.equal(actor.getSnapshot().value, "sealed");
    assert.equal(actor.getSnapshot().context.deadlineMs, deadlineBefore);
});

test("pushExtensionMs customizable (= override 10s default)", () => {
    const actor = mkActor({ loopStartMs: 1_000_000, bootMinMs: 30_000, pushExtensionMs: 5_000 }).start();
    actor.send({ type: "WATCHER_TICK", nowMs: 1_028_000 }); // now+5s = 1_033_000 > 1_030_000
    assert.equal(actor.getSnapshot().context.deadlineMs, 1_033_000);
});

test("snapshot observable : subscribe fires sur transitions", () => {
    const actor = mkActor({ loopStartMs: 1_000_000 }).start();
    const states: string[] = [];
    actor.subscribe((snap) => states.push(String(snap.value)));
    actor.send({ type: "HOOK_SEAL" });
    // initial + post-transition (au moins 2 events)
    assert.ok(states.includes("sealed"));
});
