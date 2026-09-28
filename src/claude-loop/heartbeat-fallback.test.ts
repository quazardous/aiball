// #3257 — the heartbeat stays out of a countdown that is due, not of one nobody honours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatShouldWake } from "./heartbeat-fallback.js";

test("no countdown: the heartbeat tries; a countdown still due: it stays out", () => {
    assert.equal(heartbeatShouldWake(null, 1_000_000, 10_000), "no-countdown");
    assert.equal(heartbeatShouldWake(1_005_000, 1_000_000, 10_000), null, "ahead");
    assert.equal(heartbeatShouldWake(995_000, 1_000_000, 10_000), null, "late by less than a tempo: turn:settled may still be on its way");
});

test("a countdown past its time by more than a tempo is overdue: the heartbeat tries", () => {
    assert.equal(heartbeatShouldWake(989_000, 1_000_000, 10_000), "overdue");
    assert.equal(heartbeatShouldWake(1_000_000 - 8 * 60_000, 1_000_000, 10_000), "overdue", "tvty's case: minutes past");
});
