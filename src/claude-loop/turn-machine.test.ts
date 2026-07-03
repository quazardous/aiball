// TurnMachine tests. Run: `npx tsx --test src/claude-loop/turn-machine.test.ts`.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { turnMachine } from "./turn-machine.js";

// #915 — start + register stop on test teardown. Sans le t.after,
// l'actor garde le `after(...)` delayed transition armé → setTimeout
// pingue le test runner et le job CI hang jusqu'au timeout.
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

// #805 — no_turn.fresh → no_turn.settled après tunnelMs, emit turn:settled.

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

test("re-entering no_turn (TURN_ENDED → fresh) reset le settle timer", async (t) => {
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
// #1162 — self-heal : TURN_ENDED hors in_turn (le trou qui rendait la loop
// sourde après un self-reload mid-turn : Stop hooks avalés, idle jamais
// seedé, drain tempo mort jusqu'au prochain submit humain).
// ---------------------------------------------------------------------------

test("#1162: TURN_ENDED from unknown (reload mid-turn) → no_turn + idle seedé", (t) => {
    const actor = mkActor(t);
    // Kernel rechargé en plein turn : pas de SESSION_START (claude n'a pas
    // redémarré), le premier événement reçu est le Stop de fin de tour.
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

test("#1162: TURN_ENDED from unknown émet turn:ended + turn:no_turn_since", (t) => {
    const actor = mkActor(t);
    const seen: string[] = [];
    actor.on("turn:ended", () => { seen.push("ended"); });
    actor.on("turn:no_turn_since", () => { seen.push("no_turn_since"); });
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    assert.deepEqual(seen, ["ended", "no_turn_since"]);
});

test("#1162: TURN_ENDED from unknown ré-arme le cycle settled (tempo)", async (t) => {
    const actor = mkActor(t, { tunnelMs: 20 });
    let settled = 0;
    actor.on("turn:settled", () => { settled++; });
    actor.send({ type: "TURN_ENDED", atMs: 5_000 });
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(settled >= 2, `settled re-emits expected, got ${settled}`);
});

test("#1162: TURN_ENDED en no_turn = re-stamp idempotent (ancre idle avancée)", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_ENDED", atMs: 9_000 }); // Stop d'un turn non comptabilisé
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 9_000);
});

test("#1162: le cycle nominal in_turn → TURN_ENDED reste inchangé", (t) => {
    const actor = mkActor(t);
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(actor.getSnapshot().matches("no_turn"), true);
    assert.equal(actor.getSnapshot().context.idleSinceMs, 3_000);
});
