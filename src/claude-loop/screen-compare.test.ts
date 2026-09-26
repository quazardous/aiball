// #3048 — the proxy's screen against tmux's: one normalisation for both sides,
// a mismatch named by its rows, and a running score the health line reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareScreens, normalizeScreen, readScreenCompareScore, recordScreenComparison } from "./screen-compare.js";
import { checkProxyScreen } from "./cmds/health.js";

test("normalisation: trailing spaces and bottom blank rows do not count", () => {
    assert.deepEqual(normalizeScreen("a  \nb\r\n\n\n"), ["a", "b"]);
});

test("the same screen matches, whatever the padding tmux or the model adds", () => {
    const r = compareScreens({ text: "❯ hello   \n\n", cursor: { x: 7, y: 0 } }, { text: "❯ hello", cursor: { x: 7, y: 0 } });
    assert.deepEqual([r.match, r.diffLines, r.cursorMatch], [true, 0, true]);
});

test("a differing row is named; a moved cursor alone is a mismatch; an unknown cursor is not", () => {
    const text = compareScreens({ text: "a\nb\nc", cursor: null }, { text: "a\nX\nc", cursor: { x: 0, y: 0 } });
    assert.deepEqual([text.match, text.diffLines, text.first, text.cursorMatch], [false, 1, [{ row: 1, tmux: "b", proxy: "X" }], null]);
    const cursor = compareScreens({ text: "a", cursor: { x: 1, y: 0 } }, { text: "a", cursor: { x: 0, y: 0 } });
    assert.deepEqual([cursor.match, cursor.textMatch, cursor.cursorMatch], [false, true, false]);
});

test("the score: comparisons, mismatches with the last one, moving screens skipped; the health line reads it", () => {
    const sd = mkdtempSync(join(tmpdir(), "aiball-3048-"));
    assert.equal(checkProxyScreen(sd).detail, "not compared yet");
    recordScreenComparison(sd, compareScreens({ text: "a", cursor: null }, { text: "a", cursor: null }));
    recordScreenComparison(sd, null);
    recordScreenComparison(sd, compareScreens({ text: "a", cursor: null }, { text: "b", cursor: null }), new Date("2026-09-26T12:00:00Z"));
    const s = readScreenCompareScore(sd);
    assert.deepEqual([s.comparisons, s.mismatches, s.unstable], [2, 1, 1]);
    assert.equal(s.last_mismatch?.at, "2026-09-26T12:00:00.000Z");
    const line = checkProxyScreen(sd);
    assert.equal(line.status, "ok", "an indicator, not an alarm");
    assert.match(line.detail, /2 compared with tmux, 1 differ \(1 skipped: moving\); last mismatch 2026-09-26T12:00:00.000Z, 1 row/);
});
