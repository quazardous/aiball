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
import { existsSync } from "node:fs";
import { readLoopStateInput, type HUMAN_TYPING_TTL_SEC, loopSockPath } from "./state.js";
import { computeLoopView, type LoopStateView } from "./loop-state.js";
import { openEventChannel } from "./ipc-events.js";
import {
    setIpcAfk,
    setIpcBootComplete,
    setIpcBusyDeferUntil,
    setIpcHumanTypingAtMs,
    setIpcIdleSince,
    setIpcPaneBusy,
    setIpcPaneCompacting,
    setIpcPaneInterrupted,
    setIpcPaneReady,
    setIpcPaneResuming,
} from "./ipc-state.js";

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

/** #840 Slice B — fields the timer hands back when a hook subprocess
 *  asks for live loop state over loop.sock. Mirrors `IpcState` for the
 *  fields the verdict builder actually consumes. */
interface LiveLoopStateUds {
    paneBusy: boolean;
    paneReady: boolean;
    paneCompacting: boolean;
    paneResuming: boolean;
    paneInterrupted: boolean;
    afkMode: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs: number | null;
    humanTypingAtMs: number | null;
    idleSinceMs: number | null;
    bootComplete: boolean | null;
    busyDeferUntilMs: number | null;
}

/** #840 Slice B — short-lived UDS round-trip to the timer's loop.sock
 *  for a live `ipcState` snapshot. Returns null on any failure (timer
 *  down, socket missing, ws drop, malformed reply) — the caller falls
 *  back to local file reads, preserving the historical fail-open
 *  semantic. Mirrors the pattern from `cmds/inspect.ts:queryLoopState`. */
async function fetchLiveLoopStateUds(sd: string, timeoutMs: number): Promise<LiveLoopStateUds | null> {
    const sock = loopSockPath(sd);
    if (!existsSync(sock)) return null;
    const ch = openEventChannel(sock, { reconnectMs: 100 });
    try {
        // openEventChannel reconnects forever ; race against a deadline so
        // a dead timer doesn't hang the hook subprocess forever.
        const connected = await new Promise<boolean>((resolve) => {
            const start = Date.now();
            const tick = (): void => {
                if (ch.isConnected()) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                setTimeout(tick, 25);
            };
            tick();
        });
        if (!connected) return null;
        const reply = await ch.request({ kind: "queryLoopState" }, timeoutMs);
        return (reply.data as LiveLoopStateUds | undefined) ?? null;
    } catch {
        return null;
    } finally {
        ch.close();
    }
}

/**
 * #840 Slice B — async query of the current loop state. Path A : asks
 * the timer's loop.sock for a live `ipcState` snapshot, then builds the
 * view via `readLoopStateInput` (in strict-IPC mode so no file
 * fallback fires for the markers we just received). Path B (fail-open) :
 * if the UDS query fails (timer down, no socket, timeout), drop back to
 * the legacy direct-file path. Safe to call from a spawn-per-call hook
 * subprocess.
 *
 * Pre-#840 the function was sync : it read `readLoopStateInput(sd)`
 * straight off the marker files. The UDS path eliminates the
 * `fs.read` round-trip when the timer is up, which is the common case ;
 * the file fallback is now only the cold-boot / degraded path.
 */
export async function queryLoopState(sd: string, timeoutMs = 500): Promise<LoopStateSnapshot> {
    const live = await fetchLiveLoopStateUds(sd, timeoutMs);
    if (live) {
        // Mirror the live snapshot into the subprocess's local ipcState so
        // `readLoopStateInput` returns the live values. #840 `4z59jt` :
        // `readLoopStateInput` est maintenant strict IPC ; UDS down = safe
        // defaults (= AFK off, boot grace floor, no markers active).
        setIpcPaneBusy(live.paneBusy);
        setIpcPaneReady(live.paneReady);
        setIpcPaneCompacting(live.paneCompacting);
        setIpcPaneResuming(live.paneResuming);
        setIpcPaneInterrupted(live.paneInterrupted);
        setIpcAfk(live.afkMode, live.afkExpiryMs);
        setIpcHumanTypingAtMs(live.humanTypingAtMs);
        setIpcIdleSince(live.idleSinceMs);
        if (live.bootComplete !== null) setIpcBootComplete(live.bootComplete);
        setIpcBusyDeferUntil(live.busyDeferUntilMs);
    }
    const input = readLoopStateInput(sd);
    const view = computeLoopView(input);
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
