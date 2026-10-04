/** #3540 — the wait before a restart for an update ends on idle, on its deadline, or on a human's cancel. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForRestart } from "./restart-wait.js";

const noSleep = async () => {};

test("idle: the restart goes ahead", async () => {
    let n = 0;
    assert.equal(await waitForRestart({ busy: () => n++ < 3, cancelled: () => false, untilMs: Infinity, sleep: noSleep }), "idle");
});

test("a cancel while Claude works ends the wait, however long it would be", async () => {
    let n = 0;
    assert.equal(await waitForRestart({ busy: () => true, cancelled: () => ++n > 5, untilMs: Infinity, sleep: noSleep }), "cancelled");
});

test("a cancel wins even if Claude goes idle at the same moment", async () => {
    assert.equal(await waitForRestart({ busy: () => false, cancelled: () => true, untilMs: Infinity, sleep: noSleep }), "cancelled");
});

test("without when_idle the wait gives up at its deadline", async () => {
    let t = 0;
    assert.equal(await waitForRestart({ busy: () => true, cancelled: () => false, untilMs: 10, now: () => (t += 4), sleep: noSleep }), "timeout");
});
