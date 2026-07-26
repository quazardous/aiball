// #1566 — the runner exists for the failure modes, so that's what gets tested:
// an async rejection must not escape, and a slow task must not pile up.
//
// Run: `npx tsx --test src/cron/runner.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startScheduler, schedulerStatus } from "./runner.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const statusOf = (name: string) => schedulerStatus().find((s) => s.name === name)!;

test("a sync throw is caught, recorded, and never reaches the caller", () => {
    const stop = startScheduler([
        { name: "boom", everyMs: 60_000, run: () => { throw new Error("nope"); } },
    ]);
    const s = statusOf("boom");
    assert.equal(s.runs, 1, "it still counts as a run");
    assert.equal(s.last_error, "nope");
    assert.ok(s.last_error_at, "the failure is timestamped");
    stop();
});

test("an async rejection is caught — unguarded it would kill the process", async () => {
    const stop = startScheduler([
        { name: "async-boom", everyMs: 60_000, run: async () => { throw new Error("async nope"); } },
    ]);
    await tick();
    assert.equal(statusOf("async-boom").last_error, "async nope");
    stop();
});

test("overlapping ticks are SKIPPED, not queued", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const stop = startScheduler([
        { name: "slow", everyMs: 5, run: async () => { started++; await gate; } },
    ]);

    // Boot run is in flight and never resolves until we release the gate;
    // several interval ticks fire underneath it.
    await tick(40);
    assert.equal(started, 1, "the slow task must not have been re-entered");
    const mid = statusOf("slow");
    assert.ok(mid.skipped >= 2, `expected skipped ticks, got ${mid.skipped}`);
    assert.equal(mid.running, true);

    release();
    await tick();
    const after = statusOf("slow");
    assert.equal(after.running, false);
    assert.equal(after.last_error, null, "skipping is not a failure");
    assert.ok(after.last_duration_ms !== null, "the completed run is timed");
    stop();
});

test("a kill switch skips the boot run and every tick, without hiding the task", () => {
    let ran = 0;
    const stop = startScheduler([
        { name: "off", everyMs: 10, enabled: () => false, run: () => { ran++; } },
    ]);
    assert.equal(ran, 0, "disabled means it does not run at boot either");
    const s = statusOf("off");
    assert.equal(s.enabled, false);
    assert.equal(s.runs, 0);
    assert.ok(s, "a disabled task is still listed — visible, not invisible");
    stop();
});

test("runAtBoot:false defers to the first interval, and still reports a due date", () => {
    let ran = 0;
    const stop = startScheduler([
        { name: "later", everyMs: 60_000, runAtBoot: false, run: () => { ran++; } },
    ]);
    assert.equal(ran, 0);
    assert.equal(statusOf("later").next_due_at !== null, true);
    stop();
});

test("duplicate task names are rejected — the table must stay a registry", () => {
    assert.throws(
        () => startScheduler([
            { name: "dup", everyMs: 10, run: () => {} },
            { name: "dup", everyMs: 10, run: () => {} },
        ]),
        /duplicate task name/,
    );
});
