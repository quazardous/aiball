/**
 * #944 Slice 3 — `claude-loop log` CLI internals. Locks the parsing
 * + filter compositions so the public command stays stable as the
 * NDJSON shape evolves (Slice 2's exported `LogRecord` is the
 * contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSince } from "./log.js";

test("parseSince: returns null for empty / undefined", () => {
    assert.equal(parseSince(undefined), null);
    assert.equal(parseSince(""), null);
});

test("parseSince: relative durations", () => {
    const before = Date.now();
    const sec30 = parseSince("30s")!;
    const min5 = parseSince("5m")!;
    const hour2 = parseSince("2h")!;
    const day7 = parseSince("7d")!;
    const after = Date.now();
    // 30s ago : within [now-30s, now-30s+epsilon]
    assert.ok(sec30 >= before - 30_000);
    assert.ok(sec30 <= after - 30_000 + 5);
    assert.ok(min5 >= before - 5 * 60_000);
    assert.ok(hour2 >= before - 2 * 3_600_000);
    assert.ok(day7 >= before - 7 * 86_400_000);
});

test("parseSince: ISO 8601", () => {
    const ts = parseSince("2026-06-12T10:00:00Z");
    assert.equal(ts, Date.parse("2026-06-12T10:00:00Z"));
});
