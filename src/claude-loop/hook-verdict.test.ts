// #652 Slice 2 + Slice 4 — hook-verdict unit tests.
// Run: `npx tsx --test src/claude-loop/hook-verdict.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW, buildHookVerdict, queryLoopState, type LoopStateSnapshot } from "./hook-verdict.js";
import {
    afkPath,
    bootCompletePath,
    humanTypingPath,
    loopStartTsPath,
} from "./state.js";
import { setIpcPaneReady, resetIpcStateForTests } from "./ipc-state.js";

/** Minimal LoopStateSnapshot fixture. #745 phase B : the verdict builder
 *  reads `afkHoldActive` only (AFK SM is the single source of truth) ;
 *  `humanPresent` was a strict duplicate and got dropped. */
function snap(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
    return {
        phase: "idle",
        barWord: "loop",
        afkChunk: { label: "AFK", prefix: null, color: "dim" },
        wakeAllowed: true,
        wakeSkipReason: null,
        inBootGrace: false,
        afkHoldActive: false,
        ...overrides,
    } as LoopStateSnapshot;
}

// #733 V2 — also resets `ipcState` so a previous test's `setIpcPaneReady`
// doesn't bleed into the next one (singleton module-level state).
function tmp(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "hook-verdict-test-"));
}

test("buildHookVerdict: AskUserQuestion + AFK off (autonomous loop) → deny", () => {
    const v = buildHookVerdict(snap({ afkHoldActive: false }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(v.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /autonomous aiball loop/);
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /aiball ticket comment/);
});

test("buildHookVerdict: AskUserQuestion + AFK hold active (human here) → ALLOW", () => {
    // #745 phase B option b — NOT AFK 10m/∞ means a human is here and
    // can answer the dialog ; the prior rule flipped this and denied,
    // which made AskUserQuestion effectively unreachable.
    const v = buildHookVerdict(snap({ afkHoldActive: true }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: PreToolUse + other tool → ALLOW (rule scoped to AskUserQuestion)", () => {
    const v = buildHookVerdict(snap({ afkHoldActive: false }), { kind: "PreToolUse", tool_name: "Bash" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: SessionStart → ALLOW (no rules ; hooks emit events instead)", () => {
    const v = buildHookVerdict(snap(), { kind: "SessionStart", source: "resume" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: Stop → ALLOW (no rules)", () => {
    const v = buildHookVerdict(snap(), { kind: "Stop" });
    assert.deepEqual(v, ALLOW);
});

test("ALLOW serializes as `{}` (Claude Code's default-allow output shape)", () => {
    assert.equal(JSON.stringify(ALLOW), "{}");
});

test("queryLoopState: reads marker files from sd and returns a snapshot", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    const state = queryLoopState(sd);
    assert.ok(typeof state.barWord === "string", "snapshot carries barWord");
    assert.ok(typeof state.phase === "string", "snapshot carries phase");
    assert.equal(state.inBootGrace, false, "post-boot, not in grace");
    assert.equal(state.afkHoldActive, false, "no afk file → no hold");
});

test("queryLoopState: empty sd → inBootGrace=true (the boot floor applies)", () => {
    const sd = tmp();
    const state = queryLoopState(sd);
    assert.equal(state.inBootGrace, true);
    assert.equal(state.barWord, "boot");
});

test("queryLoopState: afk file 'inf' → afkHoldActive=true", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    writeFileSync(afkPath(sd), "inf\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk file with future expiry → afkHoldActive=true", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    writeFileSync(afkPath(sd), new Date(Date.now() + 600_000).toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk file with past expiry → afkHoldActive=false (expired hold)", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    writeFileSync(afkPath(sd), new Date(Date.now() - 60_000).toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, false, "expired wait_10m doesn't count as hold");
});

test("queryLoopState + buildHookVerdict integration: post-boot autonomous loop denies AskUserQuestion", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, false);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});

test("queryLoopState + buildHookVerdict integration: AFK hold ∞ → ALLOW (human is here per AFK SM)", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    setIpcPaneReady(true);
    writeFileSync(humanTypingPath(sd), new Date().toISOString() + "\n");
    writeFileSync(afkPath(sd), "inf\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW, "AFK SM hold = human present → dialog allowed");
});
