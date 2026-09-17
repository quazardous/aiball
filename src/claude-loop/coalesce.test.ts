// #2682 — bar counter refreshes are coalesced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesce } from "./coalesce.js";

function fakeClock() {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    return {
        now: () => t,
        setTimeout: (fn: () => void, ms: number) => { timers.push({ at: t + ms, fn }); },
        async advance(ms: number) {
            t += ms;
            for (;;) {
                timers.sort((a, b) => a.at - b.at);
                const next = timers[0];
                if (!next || next.at > t) break;
                timers.shift();
                next.fn();
                await new Promise((r) => setImmediate(r));
            }
            await new Promise((r) => setImmediate(r));
        },
    };
}

test("a burst of requests runs once now and once trailing, never in parallel", async () => {
    const clock = fakeClock();
    let runs = 0, concurrent = 0, maxConcurrent = 0;
    let release: () => void = () => {};
    const run = () => new Promise<void>((resolve) => {
        runs++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        release = () => { concurrent--; resolve(); };
    });
    const refresh = coalesce(run, 5000, clock);

    void refresh();
    for (let i = 0; i < 10; i++) void refresh(); // 10 pings while the first runs
    assert.equal(runs, 1);
    release();
    await clock.advance(0);
    assert.equal(runs, 1, "the trailing run waits for the gap");
    await clock.advance(5000);
    assert.equal(runs, 2, "exactly one trailing run for the whole burst");
    release();
    await clock.advance(10_000);
    assert.equal(runs, 2, "nothing more without a new request");
    assert.equal(maxConcurrent, 1);
});

test("a lone request after the gap runs at once; one too soon runs at the gap's end", async () => {
    const clock = fakeClock();
    let runs = 0;
    const refresh = coalesce(async () => { runs++; }, 5000, clock);
    await refresh();
    assert.equal(runs, 1);
    await clock.advance(1000);
    void refresh();
    assert.equal(runs, 1, "too soon: deferred");
    await clock.advance(3999);
    assert.equal(runs, 1);
    await clock.advance(1);
    assert.equal(runs, 2, "at the end of the gap");
    await clock.advance(6000);
    await refresh();
    assert.equal(runs, 3, "past the gap: at once");
});
