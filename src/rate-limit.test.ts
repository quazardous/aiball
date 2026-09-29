// #3248 — one sliding-window limiter for the signal and pairing doors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slidingLimiter } from "./rate-limit.js";

test("at most max hits a window, per key; the window slides", () => {
    const l = slidingLimiter({ windowMs: 1000, max: 2 });
    assert.deepEqual([l.hit("a", 0), l.hit("a", 10), l.hit("a", 20), l.hit("b", 20)], [true, true, false, true]);
    assert.equal(l.hit("a", 1005), true, "the first hit left the window");
});

test("countRefused keeps a door shut while it keeps being knocked on", () => {
    const counting = slidingLimiter({ windowMs: 1000, max: 1, countRefused: true });
    const lenient = slidingLimiter({ windowMs: 1000, max: 1 });
    for (const [t, l] of [[0, counting], [0, lenient], [600, counting], [600, lenient]] as const) l.hit("x", t);
    assert.equal(lenient.hit("x", 1100), true, "only the let-in hit counted, gone by now");
    assert.equal(counting.hit("x", 1100), false, "the refused knock at 600 still counts");
});
