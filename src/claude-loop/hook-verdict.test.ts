// #652 Slice 2 — hook-verdict unit tests.
// Run: `npx tsx --test src/claude-loop/hook-verdict.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW, buildHookVerdict, queryLoopState, type LoopStateSnapshot } from "./hook-verdict.js";
import {
    bootCompletePath,
    loopStartTsPath,
    paneReadyPath,
} from "./state.js";

/** Minimal LoopStateSnapshot fixture — `barWord` is what the verdict
 *  builder consults today ; other fields default to plausible values. */
function snap(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
    return {
        phase: "idle",
        barWord: "loop",
        afkChunk: { word: "AFK", flavor: "afk" },
        wakeAllowed: true,
        wakeSkipReason: null,
        inBootGrace: false,
        ...overrides,
    } as LoopStateSnapshot;
}

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "hook-verdict-test-"));
}

test("buildHookVerdict: PreToolUse + AskUserQuestion + barWord=loop → deny + redirect", () => {
    const v = buildHookVerdict(snap({ barWord: "loop" }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(v.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /autonomous aiball loop/);
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /aiball ticket comment/);
});

test("buildHookVerdict: PreToolUse + AskUserQuestion + barWord=stop → ALLOW (human typing)", () => {
    const v = buildHookVerdict(snap({ barWord: "stop" }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: PreToolUse + AskUserQuestion + barWord=wait → ALLOW (NOT AFK hold)", () => {
    const v = buildHookVerdict(snap({ barWord: "wait" }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: PreToolUse + AskUserQuestion + barWord=boot → ALLOW (boot phase)", () => {
    const v = buildHookVerdict(snap({ barWord: "boot" }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: PreToolUse + other tool → ALLOW (rule scoped to AskUserQuestion)", () => {
    const v = buildHookVerdict(snap({ barWord: "loop" }), { kind: "PreToolUse", tool_name: "Bash" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: SessionStart → ALLOW (no rules in slice 2 — hooks emit events instead)", () => {
    const v = buildHookVerdict(snap({ barWord: "loop" }), { kind: "SessionStart", source: "resume" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: Stop → ALLOW (no rules in slice 2)", () => {
    const v = buildHookVerdict(snap({ barWord: "loop" }), { kind: "Stop" });
    assert.deepEqual(v, ALLOW);
});

test("ALLOW serializes as `{}` (Claude Code's default-allow output shape)", () => {
    assert.equal(JSON.stringify(ALLOW), "{}");
});

test("queryLoopState: reads marker files from sd and returns a snapshot", () => {
    const sd = tmp();
    // Seed enough to land outside boot-grace : loopStartTs in the past,
    // paneReady, bootComplete. computeLoopView consumes via
    // readLoopStateInput.
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.ok(typeof state.barWord === "string", "snapshot carries barWord");
    assert.ok(typeof state.phase === "string", "snapshot carries phase");
    assert.equal(state.inBootGrace, false, "post-boot, not in grace");
});

test("queryLoopState: empty sd → inBootGrace=true (the boot floor applies)", () => {
    const sd = tmp();
    // No loopStartTs file → loopStartMs defaults to now ; bootMin floor
    // keeps the loop in boot-grace until 30s elapse.
    const state = queryLoopState(sd);
    assert.equal(state.inBootGrace, true);
    assert.equal(state.barWord, "boot");
});

test("queryLoopState + buildHookVerdict integration: post-boot autonomous loop denies AskUserQuestion", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    // No userTookOver, no human typing, no AFK file → barWord computes to `loop`.
    assert.equal(state.barWord, "loop");
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});
