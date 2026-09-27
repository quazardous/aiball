// #3138 — the duration notation: `d h m s`, in order, each unit once; a bare integer is seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseDuration } from "./duration.js";

test("the notation reads d h m s, in order, spaces allowed; a bare integer is seconds", () => {
    assert.equal(parseDuration("90s"), 90);
    assert.equal(parseDuration("15m"), 900);
    assert.equal(parseDuration("1h30m"), 5400);
    assert.equal(parseDuration("1h 30m"), 5400);
    assert.equal(parseDuration("2d"), 172800);
    assert.equal(parseDuration("1d2h3m4s"), 93784);
    assert.equal(parseDuration("600"), 600);
    assert.equal(parseDuration(600), 600);
    assert.equal(parseDuration("0"), 0);
    assert.equal(parseDuration(" 2H "), 7200, "case and outer spaces do not matter");
});

test("anything else is refused: out of order, a unit twice, a fraction, a negative, empty", () => {
    for (const bad of ["30m1h", "1h1h", "1.5h", "-5m", "", "m", "1w", "abc", 1.5, -1, null, true]) {
        assert.equal(parseDuration(bad), null, JSON.stringify(bad));
    }
});

test("the notation written back: largest units first, what parses back to the same seconds", () => {
    assert.equal(formatDuration(5400), "1h30m");
    assert.equal(formatDuration(172800), "2d");
    assert.equal(formatDuration(93784), "1d2h3m4s");
    assert.equal(formatDuration(0), "0");
    for (const n of [1, 59, 60, 61, 3599, 3600, 86399, 90061]) assert.equal(parseDuration(formatDuration(n)), n);
});
