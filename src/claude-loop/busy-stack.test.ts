import { test } from "node:test";
import assert from "node:assert/strict";
import {
    seenProof,
    liveProofs,
    isBusy,
    releaseAll,
    DEFAULT_BUSY_REMANENCE_MS,
    PROOF_TURN,
    PROOF_ESC,
    PROOF_COMPACTING,
    type BusyProofs,
} from "./busy-stack.js";

const T0 = 1_000_000;
const R = DEFAULT_BUSY_REMANENCE_MS;

test("empty stack ⇒ not busy", () => {
    const p: BusyProofs = new Map();
    assert.equal(isBusy(p, T0), false);
    assert.deepEqual(liveProofs(p, T0), []);
});

test("one proof seen ⇒ busy within its remanence window", () => {
    const p = seenProof(new Map(), PROOF_ESC, T0);
    assert.equal(isBusy(p, T0), true);
    assert.equal(isBusy(p, T0 + R), true);        // boundary inclusive
    assert.equal(isBusy(p, T0 + R + 1), false);   // fallen
});

test("proof falls after remanence, but re-signalling refreshes it (hysteresis)", () => {
    let p = seenProof(new Map(), PROOF_ESC, T0);
    // re-signal just before it would fall → window extends from the new lastSeen
    p = seenProof(p, PROOF_ESC, T0 + R - 1);
    assert.equal(isBusy(p, T0 + R + 1), true);    // would have fallen without the refresh
    assert.equal(isBusy(p, T0 + R - 1 + R + 1), false);
});

test("multiple proofs : busy while ANY holds (reinforcement)", () => {
    // turn seen at T0, esc seen later → esc keeps busy after turn would fall.
    let p = seenProof(new Map(), PROOF_TURN, T0);
    p = seenProof(p, PROOF_ESC, T0 + R); // esc fresher
    // at a point where turn has fallen but esc still holds:
    const t = T0 + R + 1;
    assert.deepEqual(liveProofs(p, t).sort(), [PROOF_ESC]);
    assert.equal(isBusy(p, t), true);
});

test("compacting alone (auto-compact, no turn) keeps busy", () => {
    const p = seenProof(new Map(), PROOF_COMPACTING, T0);
    assert.equal(isBusy(p, T0 + 1), true);
});

test("releaseAll drops every proof immediately, ignoring remanence", () => {
    let p = seenProof(new Map(), PROOF_TURN, T0);
    p = seenProof(p, PROOF_ESC, T0);
    assert.equal(isBusy(p, T0), true);
    p = releaseAll();
    assert.equal(isBusy(p, T0), false);          // pane-idle = immediate clean drop
    assert.deepEqual(liveProofs(p, T0), []);
});

test("seenProof is immutable (returns a new map)", () => {
    const a = new Map();
    const b = seenProof(a, PROOF_ESC, T0);
    assert.equal(a.size, 0);
    assert.equal(b.size, 1);
});

test("custom remanence per proof is honoured", () => {
    const p = seenProof(new Map(), PROOF_TURN, T0, 100);
    assert.equal(isBusy(p, T0 + 100), true);
    assert.equal(isBusy(p, T0 + 101), false);
});
