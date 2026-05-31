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
    paneReadyPath,
    userTookOverPath,
} from "./state.js";
import { utimesSync } from "node:fs";

/** Minimal LoopStateSnapshot fixture. Slice 4 : the verdict builder now
 *  consults the derived `humanPresent` / `afkHoldActive` flags ; barWord
 *  is kept for back-compat and tests that want to assert on it. */
function snap(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
    return {
        phase: "idle",
        barWord: "loop",
        afkChunk: { label: "AFK", prefix: null, color: "dim" },
        wakeAllowed: true,
        wakeSkipReason: null,
        inBootGrace: false,
        humanPresent: false,
        afkHoldActive: false,
        ...overrides,
    } as LoopStateSnapshot;
}

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "hook-verdict-test-"));
}

test("buildHookVerdict: AskUserQuestion + autonomous (no human, no afk) → deny", () => {
    const v = buildHookVerdict(snap({ humanPresent: false, afkHoldActive: false }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(v.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /autonomous aiball loop/);
    assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /aiball ticket comment/);
});

test("buildHookVerdict: AskUserQuestion + human present → ALLOW", () => {
    const v = buildHookVerdict(snap({ humanPresent: true, afkHoldActive: false }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("buildHookVerdict: AskUserQuestion + afk hold active → deny (even if human appears present)", () => {
    // User said "wait for me" via F9 ; the dialog would stall the hold.
    const v = buildHookVerdict(snap({ humanPresent: true, afkHoldActive: true }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});

test("buildHookVerdict: AskUserQuestion + afk hold + no human → deny", () => {
    const v = buildHookVerdict(snap({ humanPresent: false, afkHoldActive: true }), { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});

test("buildHookVerdict: PreToolUse + other tool → ALLOW (rule scoped to AskUserQuestion)", () => {
    const v = buildHookVerdict(snap({ humanPresent: false, afkHoldActive: false }), { kind: "PreToolUse", tool_name: "Bash" });
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
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.ok(typeof state.barWord === "string", "snapshot carries barWord");
    assert.ok(typeof state.phase === "string", "snapshot carries phase");
    assert.equal(state.inBootGrace, false, "post-boot, not in grace");
    assert.equal(state.humanPresent, false, "no typing, no user-grace → humanPresent=false");
    assert.equal(state.afkHoldActive, false, "no afk file → no hold");
});

test("queryLoopState: empty sd → inBootGrace=true (the boot floor applies)", () => {
    const sd = tmp();
    const state = queryLoopState(sd);
    assert.equal(state.inBootGrace, true);
    assert.equal(state.barWord, "boot");
});

test("queryLoopState: human-typing marker fresh → humanPresent=true", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    // Touch the typing marker now (within 5s TTL).
    writeFileSync(humanTypingPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.humanPresent, true);
});

test("queryLoopState: user-took-over marker fresh → humanPresent=true (wider than typing)", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    // user-took-over has the user-grace window (default 600s) — typing
    // TTL (5s) is much narrower. A user who submitted a prompt 30s ago
    // is NOT typing now but IS in user-grace ; humanPresent should
    // fire on the user-grace alone.
    const p = userTookOverPath(sd);
    writeFileSync(p, new Date().toISOString() + "\n");
    utimesSync(p, (Date.now() - 30_000) / 1000, (Date.now() - 30_000) / 1000);
    const state = queryLoopState(sd);
    assert.equal(state.humanPresent, true);
});

test("queryLoopState: afk file 'inf' → afkHoldActive=true", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    writeFileSync(afkPath(sd), "inf\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk file with future expiry → afkHoldActive=true", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    writeFileSync(afkPath(sd), new Date(Date.now() + 600_000).toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk file with past expiry → afkHoldActive=false (expired hold)", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    writeFileSync(afkPath(sd), new Date(Date.now() - 60_000).toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.afkHoldActive, false, "expired wait_10m doesn't count as hold");
});

test("queryLoopState + buildHookVerdict integration: post-boot autonomous loop denies AskUserQuestion", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    assert.equal(state.humanPresent, false);
    assert.equal(state.afkHoldActive, false);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});

test("queryLoopState + buildHookVerdict integration: typing now → ALLOW", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    writeFileSync(humanTypingPath(sd), new Date().toISOString() + "\n");
    const state = queryLoopState(sd);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW);
});

test("queryLoopState + buildHookVerdict integration: AFK hold → DENY (even if human typed recently)", () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    writeFileSync(bootCompletePath(sd), new Date().toISOString() + "\n");
    writeFileSync(paneReadyPath(sd), new Date().toISOString() + "\n");
    writeFileSync(humanTypingPath(sd), new Date().toISOString() + "\n");
    writeFileSync(afkPath(sd), "inf\n");
    const state = queryLoopState(sd);
    assert.equal(state.humanPresent, true);
    assert.equal(state.afkHoldActive, true);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny", "afk hold wins over presence");
});
