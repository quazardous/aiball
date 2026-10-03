/**
 * #3500 — the tool calls Claude Code's permission system denied a loop's Claude
 * (the auto mode classifier above all: "Permission for this action was denied
 * by the Claude Code auto mode classifier"), counted with time. Claude stops
 * on such a denial and nothing on the board said so: the bar was idle, the
 * ticket's plan accepted.
 *
 * An indicator, not a rule: how many in the last hour and when the last one
 * was, so a glance tells "blocked now" (a recent last one) from "keeps
 * hitting the wall" (many in the hour). Nothing is retried or posted for it.
 */

/** What the kernel keeps: the denials of the last hour, how many since the start, the last one's reason. */
export interface DenialLog {
    /** When each denial of the last hour came (ms), oldest first. */
    recentAtMs: number[];
    total: number;
    lastAtMs: number | null;
    lastReason: string | null;
}

export const DENIAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_REASON = 200;

export function emptyDenialLog(): DenialLog {
    return { recentAtMs: [], total: 0, lastAtMs: null, lastReason: null };
}

/** The log with one more denial, the ones older than the hour dropped. */
export function withDenial(log: DenialLog, atMs: number, reason: string | null): DenialLog {
    const cut = reason && reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason;
    return {
        recentAtMs: [...log.recentAtMs.filter((t) => t > atMs - DENIAL_WINDOW_MS), atMs],
        total: log.total + 1,
        lastAtMs: atMs,
        lastReason: cut,
    };
}

/** As a host shows it (`agent.<id>.bar`'s `denials`); null when none came in the last hour. */
export interface DenialSummary {
    last_hour: number;
    total: number;
    last_at: string;
    last_reason: string | null;
}

export function denialSummary(log: DenialLog, nowMs: number): DenialSummary | null {
    const lastHour = log.recentAtMs.filter((t) => t > nowMs - DENIAL_WINDOW_MS).length;
    if (lastHour === 0 || log.lastAtMs === null) return null;
    return { last_hour: lastHour, total: log.total, last_at: new Date(log.lastAtMs).toISOString(), last_reason: log.lastReason };
}

/** How long ago, short: `40s`, `2m`, `59m`. */
function ago(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

/** The bar's chip: `⛔3·2m` (3 in the last hour, the last 2 minutes ago); empty when none. */
export function denialChip(summary: Pick<DenialSummary, "last_hour" | "last_at"> | null | undefined, nowMs: number): string {
    if (!summary) return "";
    const last = Date.parse(summary.last_at);
    if (!Number.isFinite(last) || nowMs - last >= DENIAL_WINDOW_MS) return "";
    return `⛔${summary.last_hour}·${ago(nowMs - last)}`;
}
