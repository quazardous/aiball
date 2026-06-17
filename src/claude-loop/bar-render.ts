/**
 * #715 V2 (david `wrny5s`) — bar-render layer. Carved out of `loop-state.ts`
 * to separate the rendering (bar BG phase, bar word, AFK chunk) from the
 * state machine (semantic helpers, wake gate, bus).
 *
 * `loop-state.ts` keeps the SM proper : `isInBootGrace`, `isTypingNow`,
 * `isHumanPresentHold`, `computeWakeGate`, the bus. This file consumes the SM
 * helpers and produces the bar's three rendering dimensions :
 *   - `Phase`     — bar BG (`boot` / `idle` / `busy`)
 *   - `Presence` — human presence in the loop (`boot` / `stop` /
 *                   `wait` / `loop`). Renamed from `BarWord` in #954.
 *   - `AfkChunk`  — status-right `AFK:F9` / `NOT AFK:F9` chunk descriptor
 *
 * Pure : no fs, no `Date.now`, no side effects. Consumers (`computeLoopView`,
 * `setTmuxStatus`, the win32 `formatAfkStateChunk` painter) pass a
 * `LoopStateInput` and read the typed return.
 */
import type { LoopStateInput } from "./loop-state.js";
import { effectiveAfkMode, isHumanPresentHold, isInBootGrace, isTypingNow, type AfkMode } from "./loop-state.js";

/** Bar background phase. */
export type Phase = "boot" | "idle" | "busy";

/** Bar word in the black island. */
/** #954 david `x4affp` : "word" disparaît du vocabulaire — la barre
 *  affiche des glyphes maintenant, le concept reste le statut de
 *  présence du human dans la loop. Valeurs conservées pour limiter
 *  le refactor (changement de container, pas de sémantique). */
export type Presence = "boot" | "stop" | "wait" | "loop";

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

/** Human presence in the loop (#954 `x4affp` — renamed from the
 *  legacy `renderBarWord`/`barWord`). Priority : boot > stop (live
 *  typing) > AFK active → wait > loop. Valeurs conservées par souci
 *  de containment ; mapping vers les glyphes via `humanPresenceChunk`. */
export function derivePresence(input: LoopStateInput): Presence {
    if (isInBootGrace(input)) return "boot";
    if (isTypingNow(input)) return "stop";
    if (isHumanPresentHold(input)) return "wait";
    return "loop";
}

/** Status-right AFK chunk. #751 htwguc — reads `dispAfk` if a toggle
 *  is pending (= visual feedback instant for the F9 cycle), else
 *  converges on the committed `afkMode`. Gating code (bar word, AFK
 *  SM, wake gate, countdown) keeps reading the committed value via
 *  `effectiveAfkMode` so a cycle under AFK_DEBOUNCE_MS is a noop. */
export function renderAfkChunk(input: LoopStateInput): AfkChunk {
    const hasDisp = input.dispAfkMode !== null && input.dispAfkMode !== undefined;
    const rawMode = hasDisp ? (input.dispAfkMode as AfkMode) : effectiveAfkMode(input);
    const expiryMs = hasDisp ? (input.dispAfkExpiryMs ?? null) : input.afkExpiryMs;
    // 10m auto-release : a wait_10m with an expiry past `now` collapses
    // to off (mirrors effectiveAfkMode's gate but on whichever side we read).
    const mode = (rawMode === "wait_10m" && expiryMs !== null && expiryMs <= input.nowMs)
        ? "off"
        : rawMode;
    if (mode === "wait_inf") {
        return { label: "NOT AFK", prefix: "∞", color: "red" };
    }
    if (mode === "wait_10m" && expiryMs !== null) {
        const remMs = expiryMs - input.nowMs;
        return { label: "NOT AFK", prefix: formatCountdown(remMs), color: "yellow" };
    }
    return { label: "AFK", prefix: null, color: "dim" };
}
