// #374 — pure last-actor / sole-participant gate. node:test + tsx (zero deps).
// Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isForeignActor,
    eventHasForeignActor,
    isExcludedForConsumer,
    type ActorEvent,
} from "./last-actor-gate.js";

const C = "claude-aiball-dev"; // the consumer asking "what's in my court?"

test("isForeignActor: only a real other party counts", () => {
    assert.equal(isForeignActor("david", C), true);
    assert.equal(isForeignActor(C, C), false); // self
    assert.equal(isForeignActor("auto", C), false); // auto-moderation
    assert.equal(isForeignActor(null, C), false);
    assert.equal(isForeignActor(undefined, C), false);
    assert.equal(isForeignActor("", C), false);
});

const ev = (e: Partial<ActorEvent> & { kind: string }): ActorEvent => ({
    byAgent: e.byAgent ?? null,
    decisionStatus: e.decisionStatus ?? null,
    decidedBy: e.decidedBy ?? null,
    kind: e.kind,
});

test("eventHasForeignActor: comment/lifecycle authored by another → true", () => {
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: "david" }), C), true);
    // #305: a human reopen is an action by david (not my old comment).
    assert.equal(eventHasForeignActor(ev({ kind: "ticket_reopened", byAgent: "david" }), C), true);
    assert.equal(eventHasForeignActor(ev({ kind: "ticket_closed", byAgent: "david" }), C), true);
});

test("eventHasForeignActor: my own comment / structural / auto → false", () => {
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: C }), C), false); // self
    // structural events don't move whose-court (#370 backlog stays mine).
    assert.equal(eventHasForeignActor(ev({ kind: "ticket_relation", byAgent: "david" }), C), false);
    assert.equal(eventHasForeignActor(ev({ kind: "ticket_sub_added", byAgent: "david" }), C), false);
    assert.equal(eventHasForeignActor(ev({ kind: "ticket_referenced", byAgent: "david" }), C), false);
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: "auto" }), C), false);
});

test("eventHasForeignActor: a settled decision by another → true (accept/reopen hands the ball back)", () => {
    // david accepts my plan/resolution — the decider is the actor (#374).
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: C, decisionStatus: "accepted", decidedBy: "david" }), C), true);
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: C, decisionStatus: "rejected", decidedBy: "david" }), C), true);
    // a pending proposal isn't a settled action by the other party.
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: C, decisionStatus: "pending", decidedBy: null }), C), false);
    // auto-accept (e.g. dangling-resolution on close) isn't a human action.
    assert.equal(eventHasForeignActor(ev({ kind: "comment_added", byAgent: C, decisionStatus: "accepted", decidedBy: "auto" }), C), false);
});

test("isExcludedForConsumer: §4.1 whose-court + sole-participant", () => {
    // I acted last AND a counterpart exists → awaiting them → excluded (#345/#322).
    assert.equal(isExcludedForConsumer(C, true, C), true);
    // I acted last but I'm the sole participant → my own task → kept (#370/#323).
    assert.equal(isExcludedForConsumer(C, false, C), false);
    // someone else acted last → my court → kept (#305 reopen, #374 accept).
    assert.equal(isExcludedForConsumer("david", true, C), false);
    assert.equal(isExcludedForConsumer("david", false, C), false);
    // no actor recorded → not excluded.
    assert.equal(isExcludedForConsumer(null, false, C), false);
});
