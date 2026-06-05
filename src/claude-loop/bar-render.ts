/**
 * #715 V2 (david `wrny5s`) — bar-render layer. Carved out of `loop-state.ts`
 * to separate the rendering (bar BG phase, bar word, AFK chunk) from the
 * state machine (semantic helpers, wake gate, bus).
 *
 * `loop-state.ts` keeps the SM proper : `isInBootGrace`, `isTypingNow`,
 * `isAfkActive`, `computeWakeGate`, the bus. This file consumes the SM
 * helpers and produces the bar's three rendering dimensions :
 *   - `Phase`     — bar BG (`boot` / `idle` / `busy`)
 *   - `BarWord`   — bar word in the black island (`boot` / `stop` /
 *                   `wait` / `loop`)
 *   - `AfkChunk`  — status-right `AFK:F9` / `NOT AFK:F9` chunk descriptor
 *
 * Pure : no fs, no `Date.now`, no side effects. Consumers (`computeLoopView`,
 * `setTmuxStatus`, the win32 `formatAfkStateChunk` painter) pass a
 * `LoopStateInput` and read the typed return.
 */
import type { LoopStateInput } from "./loop-state.js";
import { isAfkActive, isInBootGrace, isTypingNow } from "./loop-state.js";

/** Bar background phase. */
export type Phase = "boot" | "idle" | "busy";

/** Bar word in the black island. */
export type BarWord = "boot" | "stop" | "wait" | "loop";

/** Status-right `AFK:F9` / `NOT AFK:F9` chunk descriptor. */
export interface AfkChunk {
    /** `AFK` (autonomous loop = human is away) vs `NOT AFK` (held). */
    label: "AFK" | "NOT AFK";
    /** Countdown prefix when held — `"9m"` / `"30s"` / `"∞"` / null. */
    prefix: string | null;
    /** Color for the prefix + label. `dim` = OFF, `yellow` = 10m,
     *  `red` = ∞. The F9 key segment stays in bar_fg neutral. */
    color: "dim" | "yellow" | "red";
}

/** Format the `NOT AFK 10m` countdown prefix : always in seconds
 *  (e.g. `260s`), clamped to at least 1s so the bar never reads `0s`. */
function formatCountdown(remainingMs: number): string {
    const remSec = Math.max(1, Math.ceil(remainingMs / 1000));
    return `${remSec}s`;
}

/** Bar BG phase. */
export function renderBarBg(input: LoopStateInput): Phase {
    if (isInBootGrace(input)) return "boot";
    if (input.paneBusy) return "busy";
    return "idle";
}

/** Bar word in the black island.
 *  Priority: boot > stop (live typing) > AFK active → wait > loop. */
export function renderBarWord(input: LoopStateInput): BarWord {
    if (isInBootGrace(input)) return "boot";
    if (isTypingNow(input)) return "stop";
    if (isAfkActive(input)) return "wait";
    return "loop";
}

/** Status-right AFK chunk. #751 7zqhr5 — reads the DISPLAY fields so
 *  the chip shows the pending toggle instantly during the 3s debounce
 *  window (visual feedback for the F9 cycle). Gating code keeps reading
 *  the committed `afkMode` via `effectiveAfkMode` so a sub-3s cycle is
 *  a noop for the SM. Falls back to committed fields when display
 *  ones aren't populated (= hand-crafted test inputs / older callers). */
export function renderAfkChunk(input: LoopStateInput): AfkChunk {
    const displayMode = input.afkModeDisplay ?? input.afkMode;
    const displayExpiry = input.afkExpiryMsDisplay !== undefined
        ? input.afkExpiryMsDisplay
        : input.afkExpiryMs;
    // Apply the 10m auto-release on the DISPLAY value (consistent with
    // effectiveAfkMode but on the display side).
    const mode = (displayMode === "wait_10m"
        && displayExpiry !== null
        && displayExpiry <= input.nowMs)
        ? "off"
        : displayMode;
    if (mode === "wait_inf") {
        return { label: "NOT AFK", prefix: "∞", color: "red" };
    }
    if (mode === "wait_10m" && displayExpiry !== null) {
        const remMs = displayExpiry - input.nowMs;
        return { label: "NOT AFK", prefix: formatCountdown(remMs), color: "yellow" };
    }
    return { label: "AFK", prefix: null, color: "dim" };
}
