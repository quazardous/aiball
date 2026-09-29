// TurnMachine tests. Run: `npx tsx --test src/claude-loop/turn-machine.test.ts`.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { turnMachine } from "./turn-machine.js";

// #915 — start + register stop on test teardown. Without the t.after,
// the actor keeps the `after(...)` delayed transition armed → the setTimeout
// keeps the test runner alive and the CI job hangs until the timeout.
function mkActor(t: TestContext, input: { tunnelMs?: number } = {}) {
    const actor = createActor(turnMachine, { input }).start();
    t.after(() => actor.stop());
    return actor;
}

test("init : starts in unknown with null idleSinceMs", (t) => {
    const actor = mkActor(t);
    assert.equal(actor.getSnapshot().value, "unknown");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("SESSION_START from unknown : transition → no_turn + stamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 1_000);
});

test("TURN_STARTED from no_turn : transition → in_turn + clear idleSinceMs", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "in_turn");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("TURN_ENDED from in_turn : transition → no_turn + stamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 3_000);
});

test("SESSION_START in no_turn : reenter + restamp", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

test("SESSION_START in in_turn : forced no_turn return", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

// Emit / actor.on locus events.

test("emit turn:no_turn_since (reason=session_start) on SESSION_START", (t) => {
    const actor = mkActor(t);
    const events: { atMs: number; reason: string }[] = [];
    actor.on("turn:no_turn_since", (ev) => events.push(ev));
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_000);
    assert.equal(events[0].reason, "session_start");
});

test("emit turn:no_turn_since (reason=turn_ended) on TURN_ENDED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number; reason: string }[] = [];
    actor.on("turn:no_turn_since", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
    assert.equal(events[0].reason, "turn_ended");
});

test("emit turn:started on TURN_STARTED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    const events: { atMs: number }[] = [];
    actor.on("turn:started", (ev) => events.push(ev));
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 2_000);
});

test("emit turn:ended on TURN_ENDED", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number }[] = [];
    actor.on("turn:ended", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
});

test("TURN_STARTED in unknown : ignored (no transition)", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "TURN_STARTED", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "unknown");
});

// #805 — no_turn.fresh → no_turn.settled after tunnelMs, emit turn:settled.

test("no_turn.fresh → no_turn.settled after tunnelMs", async (t) => {
    const SETTLE = 1_000;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.deepEqual(actor.getSnapshot().value, { no_turn: "fresh" });
    const events: { idleSinceMs: number }[] = [];
    actor.on("turn:settled", (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.deepEqual(actor.getSnapshot().value, { no_turn: "settled" });
    assert.equal(events.length, 1);
    assert.equal(events[0].idleSinceMs, 1_000);
});

test("TURN_STARTED before settle cancels the timer (no turn:settled emitted)", async (t) => {
    const SETTLE = 200;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    const events: unknown[] = [];
    actor.on("turn:settled", (ev) => events.push(ev));
    actor.send({ type: "TURN_STARTED", atMs: 1_100 });
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.equal(events.length, 0);
    assert.equal(actor.getSnapshot().value, "in_turn");
});

test("re-entering no_turn (TURN_ENDED → fresh) resets the settle timer", async (t) => {
    const SETTLE = 200;
    const actor = mkActor(t, { tunnelMs: SETTLE });
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    await new Promise((r) => setTimeout(r, 50));
    actor.send({ type: "TURN_STARTED", atMs: 1_050 });
    actor.send({ type: "TURN_ENDED", atMs: 1_100 });
    assert.deepEqual(actor.getSnapshot().value, { no_turn: "fresh" });
    const events: unknown[] = [];
    actor.on("turn:settled", (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, SETTLE + 50));
    assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// #1162 — self-heal : TURN_ENDED outside in_turn (the gap that left the loop
// deaf after a mid-turn self-reload: Stop hooks swallowed, idle never
// seeded, drain tempo dead until the next human submit).
// ---------------------------------------------------------------------------

test("#1162: TURN_ENDED from unknown (reload mid-turn) → no_turn + idle seeded", (t) => {
    const actor = mkActor(t);
    // Kernel reloaded mid-turn: no SESSION_START (claude did not
    // restart), the first event received is the end-of-turn Stop.
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

test("#1162: TURN_ENDED from unknown emits turn:ended + turn:no_turn_since", (t) => {
    const actor = mkActor(t);
    const seen: string[] = [];
    actor.on("turn:ended", () => { seen.push("ended"); });
    actor.on("turn:no_turn_since", () => { seen.push("no_turn_since"); });
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    assert.deepEqual(seen, ["ended", "no_turn_since"]);
});

test("#1162: TURN_ENDED from unknown re-arms the settled cycle (tempo)", async (t) => {
    const actor = mkActor(t, { tunnelMs: 20 });
    let settled = 0;
    actor.on("turn:settled", () => { settled++; });
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(settled >= 2, `settled re-emits expected, got ${settled}`);
});

test("#1162: TURN_ENDED in no_turn = idempotent re-stamp (idle anchor moved forward)", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_ENDED", atMs: 9_000 }); // Stop of an uncounted turn
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 9_000);
});

test("#1162: the nominal in_turn → TURN_ENDED cycle is unchanged", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 3_000);
});
