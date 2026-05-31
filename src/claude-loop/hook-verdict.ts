/**
 * #652 Slice 2 — pull-state proto + verdict API for Claude Code hooks.
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
 * Slice 2 ships : the snapshot wrapper, the verdict builder, the
 * Claude Code output JSON shape, and tests. No hook migration yet
 * (slice 3 = session-start-hook, slice 4 = pretooluse-hook).
 */
import { readLoopStateInput } from "./state.js";
import { computeLoopView, type LoopStateView } from "./loop-state.js";

/**
 * Loop-state snapshot the hook reads at fire-time. Re-export of the
 * full `LoopStateView` for now — same shape the timer paints from.
 * If a future cross-process channel needs a trimmed serializable subset,
 * narrow this type at that point.
 */
export type LoopStateSnapshot = LoopStateView;

/**
 * Sync read of the current loop state from the marker files under `sd`.
 * Builds the same view the timer's `tryWake` consults. Safe to call from
 * a spawn-per-call hook subprocess — pure fs reads, no fork, no socket.
 * Throws if `sd` doesn't exist (the caller decides : default-allow on
 * error is the historical pretooluse-hook fail-open behavior).
 */
export function queryLoopState(sd: string): LoopStateSnapshot {
    return computeLoopView(readLoopStateInput(sd));
}

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

/**
 * Pure mapping `(state, context) → verdict`. Encapsulates the current
 * deny logic from `pretooluse-hook.ts:67-84` so the hook becomes a
 * thin wrapper that just feeds state in and prints the verdict out.
 *
 * Today's only deny rule (PreToolUse + AskUserQuestion + AFK active or
 * no human present) ports verbatim. Slice 3+ can add more rules as the
 * hooks migrate ; each rule lands here as a branch on `context.kind` +
 * `state.*`, keeping the hook code itself trivial.
 *
 * Returns `ALLOW` (= `{}`) for every case not explicitly denied —
 * fail-open by design, mirrors pretooluse-hook's catch-all.
 */
export function buildHookVerdict(state: LoopStateSnapshot, context: HookContext): HookVerdict {
    if (context.kind === "PreToolUse" && context.tool_name === "AskUserQuestion") {
        // AFK active → no human will click the dialog ; redirect.
        // No human present (no recent user-grace, no recent typing) →
        // autonomous loop ; redirect.
        // Note: `state.barWord` reflects the composite : `loop` = autonomous
        // (no human, no AFK hold), `wait` / `stop` = human-present in
        // various flavors. The deny rule fires when barWord === `loop`.
        if (state.barWord === "loop") {
            return {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason:
                        "AskUserQuestion (multi-choice dialog) stalls the autonomous aiball loop — no human is in front to click an answer. " +
                        "Post your question as an aiball ticket comment instead (ticket_reply on the relevant ticket); the conversation IS the channel. " +
                        "When a human is present (interactive session) this dialog is allowed.",
                },
            };
        }
    }
    return ALLOW;
}
