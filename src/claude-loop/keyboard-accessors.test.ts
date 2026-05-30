// #649 Slice 3 — keyboard accessors unit tests.
// Run: `npx tsx --test src/claude-loop/keyboard-accessors.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    HUMAN_TYPING_TTL_MS,
    humanTypingAgeMs,
    isHumanTypingRecent,
    paneInterrupted,
    userGraceActive,
    userGraceAgeMs,
    userGraceRemainingMs,
} from "./keyboard-accessors.js";
import {
    humanTypingPath,
    paneInterruptedPath,
    userTookOverPath,
} from "./state.js";

function mkSd(): string {
    return mkdtempSync(join(tmpdir(), "kbdacc-"));
}

/** Touch a file with a specific mtime (ms since epoch). */
function touchAt(p: string, mtimeMs: number): void {
    writeFileSync(p, "x\n");
    const t = mtimeMs / 1000;
    utimesSync(p, t, t);
}

test("humanTypingAgeMs: file absent → Infinity", () => {
    const sd = mkSd();
    assert.equal(humanTypingAgeMs(sd, Date.now()), Infinity);
});

test("humanTypingAgeMs: returns now - mtime", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(humanTypingAgeMs(sd, mtime + 3_000), 3_000);
});

test("humanTypingAgeMs: clamps at 0 when now < mtime (clock skew)", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(humanTypingAgeMs(sd, mtime - 500), 0);
});

test("isHumanTypingRecent: file absent → false", () => {
    const sd = mkSd();
    assert.equal(isHumanTypingRecent(sd, HUMAN_TYPING_TTL_MS, Date.now()), false);
});

test("isHumanTypingRecent: within TTL → true", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(isHumanTypingRecent(sd, 5_000, mtime + 3_000), true);
});

test("isHumanTypingRecent: at exact TTL → false (strict <)", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(isHumanTypingRecent(sd, 5_000, mtime + 5_000), false);
});

test("isHumanTypingRecent: past TTL → false", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(isHumanTypingRecent(sd, 5_000, mtime + 10_000), false);
});

test("isHumanTypingRecent: default ttlMs = HUMAN_TYPING_TTL_MS", () => {
    const sd = mkSd();
    const mtime = 1_000_000;
    touchAt(humanTypingPath(sd), mtime);
    assert.equal(isHumanTypingRecent(sd, undefined, mtime + HUMAN_TYPING_TTL_MS - 1), true);
    assert.equal(isHumanTypingRecent(sd, undefined, mtime + HUMAN_TYPING_TTL_MS), false);
});

test("userGraceAgeMs: file absent → Infinity", () => {
    const sd = mkSd();
    assert.equal(userGraceAgeMs(sd, Date.now()), Infinity);
});

test("userGraceAgeMs: returns now - mtime", () => {
    const sd = mkSd();
    const mtime = 2_000_000;
    touchAt(userTookOverPath(sd), mtime);
    assert.equal(userGraceAgeMs(sd, mtime + 30_000), 30_000);
});

test("userGraceActive: file absent → false", () => {
    const sd = mkSd();
    assert.equal(userGraceActive(sd, 600_000, Date.now()), false);
});

test("userGraceActive: within grace → true", () => {
    const sd = mkSd();
    const mtime = 2_000_000;
    touchAt(userTookOverPath(sd), mtime);
    assert.equal(userGraceActive(sd, 600_000, mtime + 100_000), true);
});

test("userGraceActive: past grace → false", () => {
    const sd = mkSd();
    const mtime = 2_000_000;
    touchAt(userTookOverPath(sd), mtime);
    assert.equal(userGraceActive(sd, 600_000, mtime + 600_001), false);
});

test("userGraceRemainingMs: file absent → 0", () => {
    const sd = mkSd();
    assert.equal(userGraceRemainingMs(sd, 600_000, Date.now()), 0);
});

test("userGraceRemainingMs: ongoing → grace - age", () => {
    const sd = mkSd();
    const mtime = 2_000_000;
    touchAt(userTookOverPath(sd), mtime);
    assert.equal(userGraceRemainingMs(sd, 600_000, mtime + 100_000), 500_000);
});

test("userGraceRemainingMs: past grace → 0 (clamped, not negative)", () => {
    const sd = mkSd();
    const mtime = 2_000_000;
    touchAt(userTookOverPath(sd), mtime);
    assert.equal(userGraceRemainingMs(sd, 600_000, mtime + 999_999), 0);
});

test("paneInterrupted: file absent → false", () => {
    const sd = mkSd();
    assert.equal(paneInterrupted(sd), false);
});

test("paneInterrupted: file present → true", () => {
    const sd = mkSd();
    writeFileSync(paneInterruptedPath(sd), "x\n");
    assert.equal(paneInterrupted(sd), true);
});

test("paneInterrupted: file removed → false again", () => {
    const sd = mkSd();
    const p = paneInterruptedPath(sd);
    writeFileSync(p, "x\n");
    assert.equal(paneInterrupted(sd), true);
    unlinkSync(p);
    assert.equal(paneInterrupted(sd), false);
});
