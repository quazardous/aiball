// IdleMachine tests. Run: `npx tsx --test src/claude-loop/idle-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { idleMachine } from "./idle-machine.js";

function mkActor() {
    return createActor(idleMachine, { input: {} });
}

test("init : starts in unknown with null idleSinceMs", () => {
    const actor = mkActor().start();
    assert.equal(actor.getSnapshot().value, "unknown");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("SESSION_START from unknown : transition → idle + stamp", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(actor.getSnapshot().context.idleSinceMs, 1_000);
});

test("TURN_STARTED from idle : transition → busy + clear idleSinceMs", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "busy");
    assert.equal(actor.getSnapshot().context.idleSinceMs, null);
});

test("TURN_ENDED from busy : transition → idle + stamp", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(actor.getSnapshot().context.idleSinceMs, 3_000);
});

test("SESSION_START in idle : reenter + restamp", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

test("SESSION_START in busy : forced idle return", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    actor.send({ type: "SESSION_START", atMs: 5_000 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(actor.getSnapshot().context.idleSinceMs, 5_000);
});

// Emit / actor.on locus events.

test("emit idle:since (reason=session_start) on SESSION_START", () => {
    const actor = mkActor().start();
    const events: { atMs: number; reason: string }[] = [];
    actor.on("idle:since", (ev) => events.push(ev));
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_000);
    assert.equal(events[0].reason, "session_start");
});

test("emit idle:since (reason=turn_ended) on TURN_ENDED", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number; reason: string }[] = [];
    actor.on("idle:since", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
    assert.equal(events[0].reason, "turn_ended");
});

test("emit idle:turn_started on TURN_STARTED", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    const events: { atMs: number }[] = [];
    actor.on("idle:turn_started", (ev) => events.push(ev));
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 2_000);
});

test("emit idle:turn_ended on TURN_ENDED", () => {
    const actor = mkActor().start();
    actor.send({ type: "SESSION_START", atMs: 1_000 });
    actor.send({ type: "TURN_STARTED", atMs: 2_000 });
    const events: { atMs: number }[] = [];
    actor.on("idle:turn_ended", (ev) => events.push(ev));
    actor.send({ type: "TURN_ENDED", atMs: 3_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 3_000);
});

test("TURN_STARTED in unknown : ignored (no transition)", () => {
    const actor = mkActor().start();
    actor.send({ type: "TURN_STARTED", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "unknown");
});
