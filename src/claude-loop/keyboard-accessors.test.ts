// #649 Slice 3 — keyboard accessors unit tests.
// Run: `npx tsx --test src/claude-loop/keyboard-accessors.test.ts`.
//
// #840 `4z59jt` — IPC-only. Tests assert via `setIpcHumanTypingAtMs`
// instead of touchAt(humanTypingPath, ...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    HUMAN_TYPING_TTL_MS,
    humanTypingAgeMs,
    isHumanTypingRecent,
    paneInterrupted,
} from "./keyboard-accessors.js";
import {
    resetIpcStateForTests,
    setIpcHumanTypingAtMs,
    setIpcPaneInterrupted,
} from "./ipc-state.js";

function mkSd(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "kbdacc-"));
}

test("humanTypingAgeMs: ipc null → Infinity", () => {
    const sd = mkSd();
    assert.equal(humanTypingAgeMs(sd, Date.now()), Infinity);
});

test("humanTypingAgeMs: returns now - humanTypingAtMs", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(humanTypingAgeMs(sd, ts + 3_000), 3_000);
});

test("humanTypingAgeMs: clamps at 0 when now < ts (clock skew)", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(humanTypingAgeMs(sd, ts - 500), 0);
});

test("isHumanTypingRecent: ipc null → false", () => {
    const sd = mkSd();
    assert.equal(isHumanTypingRecent(sd, HUMAN_TYPING_TTL_MS, Date.now()), false);
});

test("isHumanTypingRecent: within TTL → true", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(isHumanTypingRecent(sd, 5_000, ts + 3_000), true);
});

test("isHumanTypingRecent: at exact TTL → false (strict <)", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(isHumanTypingRecent(sd, 5_000, ts + 5_000), false);
});

test("isHumanTypingRecent: past TTL → false", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(isHumanTypingRecent(sd, 5_000, ts + 10_000), false);
});

test("isHumanTypingRecent: default ttlMs = HUMAN_TYPING_TTL_MS", () => {
    const sd = mkSd();
    const ts = 1_000_000;
    setIpcHumanTypingAtMs(ts);
    assert.equal(isHumanTypingRecent(sd, undefined, ts + HUMAN_TYPING_TTL_MS - 1), true);
    assert.equal(isHumanTypingRecent(sd, undefined, ts + HUMAN_TYPING_TTL_MS), false);
});

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
