/**
 * #627 — central state-machine for claude-loop's visual + behavioural surface.
 *
 * Replaces the scattered if/else trees in state.ts, timer.ts,
 * session-start-hook.ts, pty-proxy.py with a single pure function. Inputs
 * are explicit (timestamps + file-derived booleans), output is a fully
 * computed view that every consumer paints / gates against.
 *
 * Hand-rolled lightweight FSM (david's `<latest>` : "ou en refaire une
 * légère"). No external dep. Three parallel dimensions :
 *
 *   1. PHASE   : boot → idle / busy (bar BG)
 *   2. AFK     : off (autonomous loop) / wait-10m (auto-release) /
 *                wait-inf (held by F9)
 *   3. TYPING  : human-typing-now (5s TTL) / not
 *
 * Each consumer reads files / env once, hands them to `computeLoopView`,
 * and uses the result. Tests inject scenarios directly — no fs, no
 * sleeping, no actual loop running.
 */

/** Logical AFK mode derived from the AFK file content + clock. */
export type AfkMode = "off" | "wait_10m" | "wait_inf";

/** All inputs to the state computation. Caller-provided ; the service is
 *  pure (no fs, no `Date.now`). Pass `null` for "no marker / unknown". */
export interface LoopStateInput {
    /** Current time in ms-since-epoch. */
    nowMs: number;
    /** ms-since-epoch when the loop session started. */
    loopStartMs: number;
    /** Boot-grace window length in ms (typically 60_000). */
    bootGraceMs: number;
    /** True when launched with `--no-wait` (eager drain). */
    noWait: boolean;

    /** mtime of `human-typing` marker (ms-since-epoch), or null. */
    humanTypingAtMs: number | null;
    /** TTL for the human-typing marker in ms (typically 5_000). */
    humanTypingTtlMs: number;

    /** mtime of `user-took-over` marker (ms-since-epoch), or null.
     *  Silent gate — still freezes the wake gate, never paints the bar. */
    userTookOverAtMs: number | null;
    /** user-grace window length in ms (typically 600_000). */
    userGraceMs: number;

    /** AFK file mode + auto-release expiry. `expiryMs` is meaningful only
     *  in `wait_10m` ; ignored for `off` and `wait_inf`. */
    afkMode: AfkMode;
    afkExpiryMs: number | null;

    /** mtime of `idle-since` marker (ms-since-epoch), or null. */
    idleSinceMs: number | null;
    /** mtime of `wake-in-flight` marker (ms-since-epoch), or null. */
    wakeInFlightAtMs: number | null;
    /** TTL for wake-in-flight before it's considered stale (typically 2_000). */
    wakeInFlightTtlMs: number;
    /** Absolute deadline (ms-since-epoch) at which busy-defer expires.
     *  `null` = no defer set. Past-now = defer expired (treated as null). */
    busyDeferUntilMs: number | null;

    /** Pane probe results : `esc to interrupt` (busy) or `Claude Code v` /
     *  prompt signature (ready). Both can be true (busy wins for phase). */
    paneBusy: boolean;
    paneReady: boolean;

    /** True when this tryWake invocation was manually requested (file
     *  marker bypass) — skips most gates (boot, user-grace, AFK, defer). */
    manualWake?: boolean;
}

/** Bar BG state (drives `setTmuxStatus` color). */
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

/** Fully computed view of the loop. Every consumer paints / gates from this. */
export interface LoopStateView {
    /** Bar BG. */
    phase: Phase;
    /** Bar word in the black island. */
    barWord: BarWord;
    /** Status-right AFK segment. */
    afkChunk: AfkChunk;
    /** True iff `tryWake` should proceed. False is paired with a reason. */
    wakeAllowed: boolean;
    /** Single-line skip reason when `wakeAllowed` is false. Null when allowed. */
    wakeSkipReason: string | null;
    /** True while boot-grace is still running (claude may not even be
     *  at the prompt yet). Consumers use this to skip bar BG flips,
     *  AFK arming on typing, and probe overrides. */
    inBootGrace: boolean;
}

// ---------------------------------------------------------------------------
//  Internal helpers — small, composable, testable.
// ---------------------------------------------------------------------------

function isInBootGrace(input: LoopStateInput): boolean {
    if (input.bootGraceMs <= 0) return false;
    return (input.nowMs - input.loopStartMs) < input.bootGraceMs;
}

function isTypingNow(input: LoopStateInput): boolean {
    if (input.humanTypingAtMs === null) return false;
    return (input.nowMs - input.humanTypingAtMs) < input.humanTypingTtlMs;
}

function isUserGraceFresh(input: LoopStateInput): boolean {
    if (input.userTookOverAtMs === null) return false;
    return (input.nowMs - input.userTookOverAtMs) < input.userGraceMs;
}

function isWakeInFlight(input: LoopStateInput): boolean {
    if (input.wakeInFlightAtMs === null) return false;
    return (input.nowMs - input.wakeInFlightAtMs) < input.wakeInFlightTtlMs;
}

function isBusyDeferActive(input: LoopStateInput): boolean {
    if (input.busyDeferUntilMs === null) return false;
    return input.busyDeferUntilMs > input.nowMs;
}

/** True iff the AFK file represents an active hold. `wait_10m` with an
 *  expiry past `now` counts as `off` (auto-expired). */
function isAfkActive(input: LoopStateInput): boolean {
    if (input.afkMode === "off") return false;
    if (input.afkMode === "wait_inf") return true;
    // wait_10m : honor the expiry timestamp.
    if (input.afkExpiryMs === null) return false;
    return input.afkExpiryMs > input.nowMs;
}

/** Effective AFK mode after honoring the 10m auto-release. */
function effectiveAfkMode(input: LoopStateInput): AfkMode {
    if (input.afkMode === "wait_10m" && input.afkExpiryMs !== null && input.afkExpiryMs <= input.nowMs) {
        return "off";
    }
    return input.afkMode;
}

/** Format the `NOT AFK 10m` countdown prefix : `Nm` when ≥60s, `Ns`
 *  otherwise, clamped to at least 1s so the bar never reads `0s`. */
function formatCountdown(remainingMs: number): string {
    const remSec = Math.max(1, Math.ceil(remainingMs / 1000));
    if (remSec >= 60) {
        const mins = Math.ceil(remSec / 60);
        return `${mins}m`;
    }
    return `${remSec}s`;
}

// ---------------------------------------------------------------------------
//  The state machine — three parallel dimensions composed into one view.
// ---------------------------------------------------------------------------

function computePhase(input: LoopStateInput): Phase {
    if (isInBootGrace(input)) return "boot";
    if (input.paneBusy) return "busy";
    return "idle";
}

function computeBarWord(input: LoopStateInput): BarWord {
    // Priority: boot > stop (live typing) > AFK active → wait > loop.
    if (isInBootGrace(input)) return "boot";
    if (isTypingNow(input)) return "stop";
    if (isAfkActive(input)) return "wait";
    return "loop";
}

function computeAfkChunk(input: LoopStateInput): AfkChunk {
    const mode = effectiveAfkMode(input);
    if (mode === "wait_inf") {
        return { label: "NOT AFK", prefix: "∞", color: "red" };
    }
    if (mode === "wait_10m" && input.afkExpiryMs !== null) {
        const remMs = input.afkExpiryMs - input.nowMs;
        return { label: "NOT AFK", prefix: formatCountdown(remMs), color: "yellow" };
    }
    return { label: "AFK", prefix: null, color: "dim" };
}

/** Gate the wake. Manual wakes skip almost every check (file-marker bypass).
 *  Order matters for the log reason ; the first failing gate wins. */
function computeWakeGate(input: LoopStateInput): { allowed: boolean; reason: string | null } {
    const manual = input.manualWake === true;

    // The idle-since gate is the only one a manual wake honors (pinging
    // over a busy claude is always wrong).
    if (input.idleSinceMs === null) {
        return { allowed: false, reason: "no idle marker (claude busy or boot grace not yet elapsed)" };
    }
    if (manual) return { allowed: true, reason: null };

    if (isInBootGrace(input)) {
        const leftS = Math.ceil((input.bootGraceMs - (input.nowMs - input.loopStartMs)) / 1000);
        return { allowed: false, reason: `boot-grace ${leftS}s left (--wait: letting the human take over)` };
    }
    if (isUserGraceFresh(input)) {
        const secs = Math.floor(input.userGraceMs / 1000);
        return { allowed: false, reason: `user-grace active (human acted within ${secs}s, F9 to release)` };
    }
    if (isTypingNow(input)) {
        return { allowed: false, reason: "human typing right now" };
    }
    if (isAfkActive(input)) {
        return { allowed: false, reason: "NOT AFK hold active (10m countdown or ∞, F9 to release)" };
    }
    if (isBusyDeferActive(input)) {
        const remMs = (input.busyDeferUntilMs ?? input.nowMs) - input.nowMs;
        return { allowed: false, reason: `busy-defer ${remMs}ms remaining` };
    }
    if (isWakeInFlight(input)) {
        return { allowed: false, reason: "wake already in flight" };
    }
    if (input.paneBusy) {
        return { allowed: false, reason: "pane footer shows `esc to interrupt`" };
    }
    return { allowed: true, reason: null };
}

/**
 * Reduce every input dimension to the single LoopStateView consumers
 * paint / gate against. Pure function — no fs, no `Date.now`, no side
 * effects. Tests inject scenarios directly.
 */
export function computeLoopView(input: LoopStateInput): LoopStateView {
    const phase = computePhase(input);
    const barWord = computeBarWord(input);
    const afkChunk = computeAfkChunk(input);
    const gate = computeWakeGate(input);
    return {
        phase,
        barWord,
        afkChunk,
        wakeAllowed: gate.allowed,
        wakeSkipReason: gate.reason,
        inBootGrace: isInBootGrace(input),
    };
}
