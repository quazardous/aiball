/**
 * #3416 — a step of the system clock is told from time passing, in both
 * directions, and from a late tick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClockStepDetector } from "./clock-step.js";

test("time passing is not a step, however late the tick", () => {
    const d = new ClockStepDetector();
    assert.equal(d.check(1_000_000, 500), null, "the first reading is the reference");
    assert.equal(d.check(1_001_000, 1_500), null, "one second on both clocks");
    assert.equal(d.check(1_031_000, 31_500), null, "a tick thirty seconds late: both clocks moved the same");
    assert.equal(d.check(1_031_900, 32_350), null, "fifty milliseconds apart: under the threshold");
});

test("the clock set back two hours is a negative step, seen once", () => {
    const d = new ClockStepDetector();
    d.check(10_000_000, 0);
    assert.equal(d.check(10_001_000 - 7_200_000, 1_000), -7_200_000);
    assert.equal(d.check(10_002_000 - 7_200_000, 2_000), null, "the next tick starts from the new time");
});

test("a resume from sleep, or the clock set forward, is a positive step", () => {
    const d = new ClockStepDetector();
    d.check(0, 0);
    assert.equal(d.check(3_601_000, 1_000), 3_600_000);
});

test("the threshold is the caller's", () => {
    const d = new ClockStepDetector(100);
    d.check(0, 0);
    assert.equal(d.check(1_150, 1_000), 150);
});
