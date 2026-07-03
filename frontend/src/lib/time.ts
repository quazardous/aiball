/**
 * Shared time constants (UI-audit C2, slice 5) — the `7 * 24 * 60 * 60 *
 * 1000`-style literals were re-derived locally wherever needed.
 */
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** How long without a state heartbeat before a loop agent renders as
 *  "offline" (#B.177/#280 — ~4× the default 30s heartbeat so normal
 *  jitter never reads as offline). */
export const OFFLINE_THRESHOLD_MS = 2 * MINUTE_MS;

/** Consumers idle longer than this are hidden behind the "show stale"
 *  toggle. */
export const STALE_THRESHOLD_MS = WEEK_MS;
