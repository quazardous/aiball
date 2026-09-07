// #2074 — the enrolment switch: the pairing door is SHUT unless a human has
// just opened it.
//
// Why this exists. `/api/nodes/enroll` is the sixth public path out of 132
// routes, and the first that is neither "am I alive" nor "let me in": it writes
// to the database without anyone having proved anything. It is bounded — it can
// mint nothing, it is rate-limited, its rows expire — but it is structurally a
// different kind of route from the rest, and it serves a gesture done a few
// times a year. A permanent door for that is the wrong trade.
//
// So it becomes conditional on an ORDINARY, authenticated route: a moderator
// opens a short window, exactly like putting a device into pairing mode.
//
// DELIBERATELY IN MEMORY. The window dies with the process, so any restart —
// crash, upgrade, reload — leaves the door shut. For a gate, failing closed is
// the property you want; persisting it would mean an outage could hand you back
// an open door you had forgotten about. The window is minutes long, so nothing
// of value is lost by not surviving.

/** Default window: long enough to walk to the other machine and type. */
export const DEFAULT_PAIRING_WINDOW_MS = 10 * 60 * 1000;
/** Ceiling, so "open it for a day" is not one typo away. */
export const MAX_PAIRING_WINDOW_MS = 60 * 60 * 1000;

let openUntilMs = 0;
let openedBy: string | null = null;

export interface PairingWindow {
    open: boolean;
    /** ISO of the moment it shuts, or null when it is already shut. */
    open_until: string | null;
    /** Seconds left, 0 when shut — what a UI counts down. */
    seconds_left: number;
    /** Who opened it, for the panel to show. Null when shut. */
    opened_by: string | null;
    /** How long `open` opens it for, so a UI can say so without hardcoding
     *  a duration this module owns. */
    default_seconds: number;
}

export function pairingWindow(nowMs: number = Date.now()): PairingWindow {
    const open = openUntilMs > nowMs;
    return {
        open,
        open_until: open ? new Date(openUntilMs).toISOString() : null,
        seconds_left: open ? Math.ceil((openUntilMs - nowMs) / 1000) : 0,
        opened_by: open ? openedBy : null,
        default_seconds: DEFAULT_PAIRING_WINDOW_MS / 1000,
    };
}

/** Open for `ms`, clamped to the ceiling. Re-opening replaces the window
 *  rather than extending it, so the answer to "how long is it open" is always
 *  the last thing a human chose. */
export function openPairingWindow(by: string, ms: number = DEFAULT_PAIRING_WINDOW_MS, nowMs: number = Date.now()): PairingWindow {
    const span = Math.min(Math.max(1_000, ms), MAX_PAIRING_WINDOW_MS);
    openUntilMs = nowMs + span;
    openedBy = by;
    return pairingWindow(nowMs);
}

/** Shut it now — the gesture for "I'm done pairing", and the panic button. */
export function closePairingWindow(nowMs: number = Date.now()): PairingWindow {
    openUntilMs = 0;
    openedBy = null;
    return pairingWindow(nowMs);
}

/** Test seam: reset module state between cases. */
export function __resetPairingWindow(): void {
    openUntilMs = 0;
    openedBy = null;
}
