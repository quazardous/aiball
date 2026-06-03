#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop PreToolUse hook for `AskUserQuestion` (#264).
 *
 * David's "best of 2 mondes" (#nt5w7b): don't amputate Claude's
 * AskUserQuestion feature, but in an AUTONOMOUS loop (no human in front)
 * a multi-choice dialog stalls the loop — there's nobody to click. So we
 * deny AskUserQuestion ONLY when no human is taking over OR an AFK hold
 * is active, and the deny reason redirects the agent to ask via an
 * aiball ticket comment instead.
 *
 * #652 Slice 4 — refactored to use the slice 2 helpers :
 *   - `queryLoopState(sd)` returns a typed `LoopStateSnapshot` (extends
 *     LoopStateView with `afkHoldActive`, the sole human-present signal
 *     since #745 phase B retired `humanPresent`).
 *   - `buildHookVerdict(state, context)` is the pure mapping that
 *     decides allow / deny. AskUserQuestion is denied when AFK is off
 *     (autonomous loop, no human to click) and allowed when an AFK hold
 *     is active (NOT AFK 10m / ∞ = human present).
 *
 * Fail-open by design : any error short-circuits to allow, and the
 * matcher already scopes us to AskUserQuestion. Always exits 0.
 */
import { readFileSync } from "node:fs";
import { buildHookVerdict, queryLoopState } from "./hook-verdict.js";
import { CL_ENV } from "./env-vars.js";

function allow(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

try {
    // Drain stdin (Claude Code pipes the PreToolUse payload). We don't
    // need it — the matcher already scopes us to AskUserQuestion — but
    // reading avoids a broken pipe on the writer side.
    try {
        readFileSync(0, "utf8");
    } catch {
        /* no stdin available */
    }

    const sd = process.env[CL_ENV.STATE_DIR];
    // Not inside a loop → interactive session, a human can answer. Allow.
    if (!sd) allow();

    const state = queryLoopState(sd);
    const verdict = buildHookVerdict(state, { kind: "PreToolUse", tool_name: "AskUserQuestion" });
    process.stdout.write(JSON.stringify(verdict) + "\n");
    process.exit(0);
} catch {
    allow();
}
