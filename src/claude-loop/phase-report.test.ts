// #3157 — the loop says its phase when it changes, `boot` at once on a fresh
// start, nothing new on a reattach until the phase moves, and every heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PhaseReport } from "./phase-report.js";

test("a fresh start says boot at once, then each change of phase, not the same phase twice", () => {
    const said: string[] = [];
    const r = new PhaseReport((p) => said.push(p), { fresh: true });
    assert.deepEqual(said, ["boot"]);
    r.onPhase("boot");
    r.onPhase("idle");
    r.onPhase("idle");
    r.onPhase("busy");
    assert.deepEqual(said, ["boot", "idle", "busy"]);
});

test("a reattach says nothing at start; its first view gives the phase it is in", () => {
    const said: string[] = [];
    const r = new PhaseReport((p) => said.push(p), { fresh: false });
    assert.deepEqual(said, [], "no boot for a Claude already running");
    r.onPhase("idle");
    r.onPhase("idle");
    assert.deepEqual(said, ["idle"]);
});

test("the heartbeat always speaks, and a change after it is still said", () => {
    const said: string[] = [];
    const r = new PhaseReport((p) => said.push(p), { fresh: false });
    r.onHeartbeat("idle");
    r.onHeartbeat("idle");
    r.onPhase("idle");
    r.onPhase("busy");
    assert.deepEqual(said, ["idle", "idle", "busy"]);
});

test("a push that throws does not break the loop", () => {
    const r = new PhaseReport(() => { throw new Error("daemon down"); }, { fresh: true });
    assert.doesNotThrow(() => r.onPhase("idle"));
});
