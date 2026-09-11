/**
 * #2333 — which loops the all-agents message and hold reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickHoldTargets, type LoopCandidate } from "./loop-hold.js";

const c = (consumer_id: string, kind: string, present: boolean | null): LoopCandidate => ({ consumer_id, kind, present });

test("every agent loop connected now, and nobody else", () => {
    const all = [
        c("zeta", "agent", true),
        c("alpha", "sandbox", true),
        c("david", "human", true),
        c("aiball", "system", true),
        c("gone", "agent", false),
        c("unknown", "agent", null),
    ];
    assert.deepEqual(pickHoldTargets(all), ["alpha", "zeta"]);
    assert.deepEqual(pickHoldTargets(all, []), ["alpha", "zeta"], "an empty list names nobody in particular");
});

test("a named list narrows the pick, and cannot add a loop that is not running", () => {
    const all = [c("a", "agent", true), c("b", "agent", true), c("off", "agent", false)];
    assert.deepEqual(pickHoldTargets(all, ["b", "off", "nobody"]), ["b"]);
});
