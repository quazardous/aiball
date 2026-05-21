/**
 * claude-loop pane-error backoff (#332).
 *
 * David's rule (#2wv4rh): « une erreur fait crasher le flow, on essaye
 * bêtement de reprendre en respectant une échelle exponentielle ». So
 * the handler here is deliberately DUMB and uniform — no per-error
 * cinematics, no trying to understand what Claude Code wants:
 *
 *   error string visible in the pane
 *     → arm an exponential backoff defer (reuses `busy-defer-until`)
 *     → when the window elapses the normal wake re-pings = resume
 *     → still erroring → back off longer (attempts++ → bigger delay)
 *     → pane error-free → reset the counter (resume succeeded)
 *
 * The "plusieurs types d'erreur proprement" part (#gge52s) lives ONLY
 * in the detection registry `ERROR_PATTERNS`: teaching the loop a new
 * error = one row, zero change to the handler. Every entry is handled
 * identically; `id` is for the log/bar only.
 *
 * `compacting` is NOT an error (it's an internal busy state that
 * resolves itself), so it stays in `classifyPaneSpecial` (state.ts),
 * out of this module.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armBusyDefer } from "./state.js";

/**
 * One recognized error type. `id` labels the log line / bar suffix;
 * it does NOT select a handler — every entry gets the same dumb
 * exponential backoff. Add a row to recognize a new error string.
 */
export interface ErrorPattern {
    id: string;
    match: RegExp;
}

/**
 * Error strings that crash the turn / flow. Ordered; first match wins
 * (only decides which `id` lands in the log — handling is uniform).
 * Seeds the three david called out plus the backend-overload variant;
 * extend here, nowhere else.
 */
export const ERROR_PATTERNS: ErrorPattern[] = [
    { id: "rate-limit", match: /Rate limited|temporarily limiting requests/i },
    { id: "overloaded", match: /Overloaded|overloaded_error|\b529\b/i },
    { id: "api-error", match: /API Error|APIError/i },
];

/** First error id whose pattern matches `text`, or null if clean. */
export function matchPaneError(text: string): string | null {
    for (const p of ERROR_PATTERNS) {
        if (p.match.test(text)) return p.id;
    }
    return null;
}

// Exponential backoff knobs, env-overridable like the rest of CL_*.
export const ERROR_BACKOFF_BASE_MS =
    Math.max(0, Number(process.env.CL_ERROR_BACKOFF_BASE_MS ?? 5000));
export const ERROR_BACKOFF_FACTOR =
    Math.max(1, Number(process.env.CL_ERROR_BACKOFF_FACTOR ?? 2));
export const ERROR_BACKOFF_CAP_MS =
    Math.max(0, Number(process.env.CL_ERROR_BACKOFF_CAP_MS ?? 600_000)); // 10 min

/**
 * Dumb exponential schedule: `base · factor^(attempts-1)`, capped.
 * `attempts` is 1-based (attempt #1 = base delay). e.g. base 5s / factor
 * 2 → 5s, 10s, 20s, 40s, … capped at 10 min.
 */
export function nextBackoffMs(attempts: number): number {
    const n = Math.max(1, Math.floor(attempts));
    const ms = ERROR_BACKOFF_BASE_MS * Math.pow(ERROR_BACKOFF_FACTOR, n - 1);
    return Math.min(ms, ERROR_BACKOFF_CAP_MS);
}

export interface BackoffState {
    /** The error id currently being backed off. */
    id: string;
    /** 1-based attempt count for `id`. */
    attempts: number;
    /** ISO time of the last arm — for `cat error-backoff` debugging. */
    lastAt: string;
}

/**
 * Durable backoff counter, sibling of `busy-defer-until`. Persistent so
 * the schedule survives a hook process exiting (same reasoning as
 * `busyDeferUntilPath`) and is inspectable (`cat error-backoff`).
 */
export function errorBackoffPath(sd: string): string { return join(sd, "error-backoff"); }

/** Read the counter, or null if not armed / unreadable. */
export function readErrorBackoff(sd: string): BackoffState | null {
    const p = errorBackoffPath(sd);
    if (!existsSync(p)) return null;
    try {
        const s = JSON.parse(readFileSync(p, "utf8")) as BackoffState;
        if (s && typeof s.id === "string" && typeof s.attempts === "number") return s;
        return null;
    } catch { return null; }
}

/** Clear the counter — call when the pane is error-free (resume OK). */
export function resetErrorBackoff(sd: string): void {
    try { unlinkSync(errorBackoffPath(sd)); } catch { /* not armed */ }
}

/**
 * Register one more occurrence of error `id` and arm the defer for the
 * next backoff step. Same id → attempts++ (longer wait); a different id
 * → restart at attempt 1 (fresh error class). Arms `busy-defer-until`
 * via `armBusyDefer` so the existing wake gates honor the window with
 * no new plumbing. Returns the step info for the log line + bar suffix.
 */
export function armErrorBackoff(sd: string, id: string): { attempts: number; ms: number; untilIso: string } {
    const prev = readErrorBackoff(sd);
    const attempts = prev && prev.id === id ? prev.attempts + 1 : 1;
    const ms = nextBackoffMs(attempts);
    const next: BackoffState = { id, attempts, lastAt: new Date().toISOString() };
    try { writeFileSync(errorBackoffPath(sd), JSON.stringify(next) + "\n"); } catch { /* fail open */ }
    const untilIso = armBusyDefer(sd, ms);
    return { attempts, ms, untilIso };
}
