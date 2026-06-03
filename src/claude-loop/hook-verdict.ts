/**
 * #652 Slice 2 + Slice 4 — pull-state proto + verdict API for Claude Code hooks.
 *
 * Hooks (session-start-hook, pretooluse-hook, stop-hook) need to ASK the
 * loop "what's the current state?" before deciding what to do (block a
 * tool call, paint the bar, etc.). They're spawn-per-call subprocesses
 * but co-located with the timer (same `$CL_STATE_DIR`), so the simplest
 * channel is a local sync read off the marker files via the existing
 * `readLoopStateInput` + `computeLoopView` pipeline — no daemon round-
 * trip, no UDS protocol to design. This module exposes the typed wrapper
 * + a pure verdict-builder that maps a state snapshot to the Claude Code
 * hook output shape (allow / deny / continue).
 *
 * The plan accepted on #652 mentioned a daemon HTTP endpoint as the
 * canonical channel. In practice local fs reads are faster, simpler,
 * and don't need the daemon to be up — if a cross-process / remote
 * scenario ever surfaces (e.g. a hook running on a different host than
 * the timer), a slice 2b can add an HTTP variant on top of the same
 * `LoopStateSnapshot` shape ; the verdict-builder stays unchanged.
 *
 * #745 phase B (david `9aedjr` option b) — `humanPresent` was a derived
 * flag combining typing + user-grace freshness, both of which the AFK
 * state machine already covers (typing arms NOT AFK 10m). Removed. The
 * verdict builder now reads `afkHoldActive` only, the AFK SM is the
 * single source of truth for "is a human here."
 */
import { readLoopStateInput, type HUMAN_TYPING_TTL_SEC } from "./state.js";
import { computeLoopView, type LoopStateView } from "./loop-state.js";

/**
 * Loop-state snapshot the hook reads at fire-time. Extends `LoopStateView`
 * (what the timer paints from) with one derived flag : whether an AFK
 * hold is active (NOT AFK 10m or ∞). That single flag is enough for the
 * verdict builder — it's the AFK SM's notion of "human present."
 */
export type LoopStateSnapshot = LoopStateView & {
    /** True iff the AFK file represents an active hold (`wait_10m` with
     *  a future expiry, or `wait_inf`). Mirrors `afkActive` in state.ts
     *  (#351). Drives the pretooluse-hook AskUserQuestion gate. */
    afkHoldActive: boolean;
};

/**
 * Sync read of the current loop state from the marker files under `sd`.
 * Builds the same view the timer's `tryWake` consults + the
 * `afkHoldActive` flag consumed by the verdict builder. Safe to call
 * from a spawn-per-call hook subprocess — pure fs reads, no fork, no
 * socket. Throws if `sd` doesn't exist (the caller decides :
 * default-allow on error is the historical pretooluse-hook fail-open
 * behavior).
 */
export function queryLoopState(sd: string): LoopStateSnapshot {
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
    // afkHoldActive : wait_inf, or wait_10m with future expiry.
    const afkHoldActive =
        input.afkMode === "wait_inf"
        || (input.afkMode === "wait_10m" && input.afkExpiryMs !== null && input.afkExpiryMs > input.nowMs);
    return { ...view, afkHoldActive };
}

// Re-export marker so an importer doesn't drag in a transitive type-only
// dependency on state.ts internals (linter convenience).
export type { HUMAN_TYPING_TTL_SEC };

/**
 * Context the hook supplies to the verdict builder. `kind` mirrors the
 * `HookEvent` discriminants from `hook-service.ts` so a future migration
 * can pipe the in-memory event through `buildHookVerdict` unchanged.
 * `tool_name` is required for PreToolUse (the matcher narrows the hook
 * to a specific tool ; the verdict may further branch on it).
 */
export type HookContext =
    | { kind: "PreToolUse"; tool_name: string }
    | { kind: "SessionStart"; source: "startup" | "resume" | "compact" | "clear" }
    | { kind: "Stop" };

/**
 * Claude Code hook output shape — what the hook prints on stdout before
 * exiting 0. Matches the existing pretooluse-hook conventions :
 *   - `{}` → allow (default)
 *   - `{ hookSpecificOutput: { permissionDecision: "deny", ... } }` → deny
 *
 * The builder returns the OBJECT ; the hook caller serializes + writes.
 * Empty object means "allow / default" — the same as if the hook had
 * never run.
 */
export interface HookVerdict {
    hookSpecificOutput?: {
        hookEventName: "PreToolUse" | "SessionStart" | "Stop";
        permissionDecision?: "deny" | "allow";
        permissionDecisionReason?: string;
    };
}

/** Convenience constant for "no verdict / allow / default" — the hook
 *  serializes this as `{}` which is Claude Code's allow-by-default path. */
export const ALLOW: HookVerdict = {};

const ASK_USER_QUESTION_REDIRECT =
    "AskUserQuestion (multi-choice dialog) stalls the autonomous aiball loop — no human is in front to click an answer. " +
    "Post your question as an aiball ticket comment instead (ticket_reply on the relevant ticket); the conversation IS the channel. " +
    "When a human is present (interactive session) this dialog is allowed.";

/**
 * Pure mapping `(state, context) → verdict`. Encapsulates the deny logic
 * the hooks used to inline ; each hook becomes a thin wrapper that just
 * feeds state in and prints the verdict out.
 *
 * AskUserQuestion rule (#746 david `9aedjr` option b) — gated on the AFK
 * SM as the single source of truth for "is a human present" :
 *   - `afkHoldActive` (NOT AFK 10m or ∞) → ALLOW : a human is here ; let
 *     the dialog through, they can answer it.
 *   - `!afkHoldActive` (AFK off, autonomous loop) → deny : no one to click.
 *
 * The previous rule also looked at a separate `humanPresent` (typing +
 * user-grace) flag, which was a strict duplicate of the AFK SM (typing
 * arms NOT AFK 10m). Removed in #745 phase B — the AFK SM owns the
 * "human here" signal end-to-end (bar shows it live, F9 controls it).
 *
 * Returns `ALLOW` (= `{}`) for every case not explicitly denied —
 * fail-open by design, mirrors pretooluse-hook's catch-all.
 */
export function buildHookVerdict(state: LoopStateSnapshot, context: HookContext): HookVerdict {
    if (context.kind === "PreToolUse" && context.tool_name === "AskUserQuestion") {
        if (!state.afkHoldActive) {
            return {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: ASK_USER_QUESTION_REDIRECT,
                },
            };
        }
    }
    return ALLOW;
}
