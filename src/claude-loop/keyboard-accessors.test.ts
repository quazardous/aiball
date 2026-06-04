// #649 Slice 3 — keyboard accessors unit tests.
// Run: `npx tsx --test src/claude-loop/keyboard-accessors.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    HUMAN_TYPING_TTL_MS,
    humanTypingAgeMs,
    isHumanTypingRecent,
    paneInterrupted,
} from "./keyboard-accessors.js";
import { humanTypingPath } from "./state.js";
import { setIpcPaneInterrupted, resetIpcStateForTests } from "./ipc-state.js";

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

// #745 phase B — userGrace* helpers + tests dropped. AFK SM is the
// single source of truth for "human present" now ; the helpers below
// cover the only remaining presence signals (typing + pane state).

// #733 V2 — `paneInterrupted` now reads `ipcState.paneInterrupted` only ;
// no file fallback. Each test resets the singleton first to avoid leak.
test("paneInterrupted: ipcState null → false", () => {
    resetIpcStateForTests();
    const sd = mkSd();
    assert.equal(paneInterrupted(sd), false);
});

test("paneInterrupted: ipcState true → true", () => {
    resetIpcStateForTests();
    const sd = mkSd();
    setIpcPaneInterrupted(true);
    assert.equal(paneInterrupted(sd), true);
});

test("paneInterrupted: ipcState cleared back → false", () => {
    resetIpcStateForTests();
    const sd = mkSd();
    setIpcPaneInterrupted(true);
    assert.equal(paneInterrupted(sd), true);
    setIpcPaneInterrupted(false);
    assert.equal(paneInterrupted(sd), false);
});
