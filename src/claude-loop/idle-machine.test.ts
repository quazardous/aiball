// IdleMachine tests. Run: `npx tsx --test src/claude-loop/idle-machine.test.ts`.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { idleMachine } from "./idle-machine.js";

// #915 — start + register stop on test teardown. Sans le t.after,
// l'actor garde le `after(...)` delayed transition armé → setTimeout
// pingue le test runner et le job CI hang jusqu'au timeout.
function mkActor(t: TestContext, input: { tunnelMs?: number } = {}) {
    const actor = createActor(idleMachine, { input }).start();
    t.after(() => actor.stop());
    return actor;
}

test("init : starts in unknown with null idleSinceMs", (t) => {
    const actor = mkActor(t);
    assert.equal(actor.getSnapshot().value, "unknown");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("SESSION_START from unknown : transition → idle + stamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(actor.getSnapshot().matches("idle"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 1_000);
});

test("TURN_STARTED from idle : transition → busy + clear idleSinceMs", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "busy");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("TURN_ENDED from busy : transition → idle + stamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(actor.getSnapshot().matches("idle"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 3_000);
});

test("SESSION_START in idle : reenter + restamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("idle"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

test("SESSION_START in busy : forced idle return", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("idle"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

// Emit / actor.on locus events.

test("emit idle:since (reason=session_start) on SESSION_START", (t) => {
    const actor = mkActor(t);
    const events: { atMs: number; reason: string }[] = [];
    actor.on("idle:since", (ev) => events.push(ev));
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_000);
    assert.equal(events[0].reason, "session_start");
});

test("emit idle:since (reason=turn_ended) on TURN_ENDED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number; reason: string }[] = [];
    actor.on("idle:since", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
    assert.equal(events[0].reason, "turn_ended");
});

test("emit idle:turn_started on TURN_STARTED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    const events: { atMs: number }[] = [];
    actor.on("idle:turn_started", (ev) => events.push(ev));
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 2_000);
});

test("emit idle:turn_ended on TURN_ENDED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number }[] = [];
    actor.on("idle:turn_ended", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
});

test("TURN_STARTED in unknown : ignored (no transition)", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "TURN_STARTED", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "unknown");
});

// #805 — idle.fresh → idle.settled après tunnelMs, emit idle:settled.

test("idle.fresh → idle.settled after tunnelMs", async (t) => {
    const SETTLE = 1_000;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.deepEqual(actor.getSnapshot().value, { idle: "fresh" });
    const events: { idleSinceMs: number }[] = [];
    actor.on("idle:settled", (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.deepEqual(actor.getSnapshot().value, { idle: "settled" });
    assert.equal(events.length, 1);
    assert.equal(events[0].idleSinceMs, 1_000);
});

test("TURN_STARTED before settle cancels the timer (no idle:settled emitted)", async (t) => {
    const SETTLE = 200;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    const events: unknown[] = [];
    actor.on("idle:settled", (ev) => events.push(ev));
    actor.send({ type: "TURN_STARTED", atMs: 1_100 });
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.equal(events.length, 0);
    assert.equal(actor.getSnapshot().value, "busy");
});

test("re-entering idle (TURN_ENDED → fresh) reset le settle timer", async (t) => {
    const SETTLE = 200;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    await new Promise((r) => setTimeout(r, 50));
    actor.send({ type: "TURN_STARTED", atMs: 1_050 });
    actor.send({ type: "TURN_ENDED", atMs: 1_100 });
    assert.deepEqual(actor.getSnapshot().value, { idle: "fresh" });
    const events: unknown[] = [];
    actor.on("idle:settled", (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.equal(events.length, 1);
});
