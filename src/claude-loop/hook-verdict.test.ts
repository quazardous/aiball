// #652 Slice 2 + Slice 4 — hook-verdict unit tests.
// Run: `npx tsx --test src/claude-loop/hook-verdict.test.ts`.
//
// #840 `4z59jt` — david "drop every marker file".
// We simulate the loop state on the IPC side directly
// (setIpcAfk/setIpcBootComplete/...). UDS down ⇒ queryLoopState falls back
// on the local ipcState (= what we set). No more
// writeFileSync(afkPath/bootCompletePath/humanTypingPath).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW, buildHookVerdict, queryLoopState, type LoopStateSnapshot } from "./hook-verdict.js";
import { loopStartTsPath } from "./state.js";
import {
    resetIpcStateForTests,
    setIpcAfk,
    setIpcBootComplete,
    setIpcHumanTypingAtMs,
    setIpcPaneReady,
} from "./ipc-state.js";

/** Minimal LoopStateSnapshot fixture. #745 phase B : the verdict builder
 *  reads `afkHoldActive` only (AFK SM is the single source of truth) ;
 *  `humanPresent` was a strict duplicate and got dropped. */
function snap(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
    return {
        phase: "idle",
        presence: "loop",
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

test("queryLoopState: ipc-only post-boot snapshot", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    const state = await queryLoopState(sd);
    assert.ok(typeof state.presence === "string", "snapshot carries presence");
    assert.ok(typeof state.phase === "string", "snapshot carries phase");
    assert.equal(state.inBootGrace, false, "post-boot, not in grace");
    assert.equal(state.afkHoldActive, false, "no afk ipc → no hold");
});

test("queryLoopState: empty sd → inBootGrace=true (the boot floor applies)", async () => {
    const sd = tmp();
    const state = await queryLoopState(sd);
    assert.equal(state.inBootGrace, true);
    assert.equal(state.presence, "boot");
});

test("queryLoopState: afk ipc 'wait_inf' → afkHoldActive=true", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcAfk("wait_inf", null);
    const state = await queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk ipc wait_10m future expiry → afkHoldActive=true", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcAfk("wait_10m", Date.now() + 600_000);
    const state = await queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
});

test("queryLoopState: afk ipc wait_10m past expiry → afkHoldActive=false (expired hold)", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcAfk("wait_10m", Date.now() - 60_000);
    const state = await queryLoopState(sd);
    assert.equal(state.afkHoldActive, false, "expired wait_10m doesn't count as hold");
});

test("queryLoopState + buildHookVerdict integration: post-boot autonomous loop denies AskUserQuestion", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    const state = await queryLoopState(sd);
    assert.equal(state.afkHoldActive, false);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.equal(v.hookSpecificOutput?.permissionDecision, "deny");
});

test("queryLoopState + buildHookVerdict integration: AFK hold ∞ → ALLOW (human is here per AFK SM)", async () => {
    const sd = tmp();
    writeFileSync(loopStartTsPath(sd), String(Date.now() - 60_000));
    setIpcBootComplete(true);
    setIpcPaneReady(true);
    setIpcHumanTypingAtMs(Date.now());
    setIpcAfk("wait_inf", null);
    const state = await queryLoopState(sd);
    assert.equal(state.afkHoldActive, true);
    const v = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(v, ALLOW, "AFK SM hold = human present → dialog allowed");
});

// #3393 — `claude_loop.questions`: `present` is the rule above; `ticket_only`
// refuses the dialog whoever is present, and says why.
test("buildHookVerdict: questions=ticket_only → deny even with a human present, naming the setting", () => {
    for (const afkHoldActive of [true, false]) {
        const v = buildHookVerdict(snap({ afkHoldActive }), { kind: "PreToolUse", tool_name: "AskUserQuestion", questions: "ticket_only" });
        assert.equal(v.hookSpecificOutput?.permissionDecision, "deny", `human present: ${afkHoldActive}`);
        assert.match(v.hookSpecificOutput?.permissionDecisionReason ?? "", /claude_loop\.questions: ticket_only/);
    }
});

test("buildHookVerdict: questions=present → today's rule: allowed with a human present, denied without", () => {
    const ctx = { kind: "PreToolUse", tool_name: "AskUserQuestion", questions: "present" } as const;
    assert.deepEqual(buildHookVerdict(snap({ afkHoldActive: true }), ctx), {});
    assert.equal(buildHookVerdict(snap({ afkHoldActive: false }), ctx).hookSpecificOutput?.permissionDecision, "deny");
});

test("buildHookVerdict: ticket_only gates the dialog only, not another tool", () => {
    assert.deepEqual(buildHookVerdict(snap({ afkHoldActive: true }), { kind: "PreToolUse", tool_name: "Bash", questions: "ticket_only" }), {});
});
