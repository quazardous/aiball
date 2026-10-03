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

/** One denied tool call. */
export interface Denial {
    atMs: number;
    tool: string | null;
    reason: string | null;
}

/**
 * What the kernel keeps: the denials of the last hour, how many since the
 * start, and (#3509) when the loop answered repeated denials with the
 * configured prompt.
 */
export interface DenialLog {
    /** The denials of the last hour, oldest first. */
    recent: Denial[];
    total: number;
    lastAtMs: number | null;
    lastReason: string | null;
    /** #3509 — when the `on_repetitive_denied` prompt was sent, the last hour's. */
    sentAtMs: number[];
}

export const DENIAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_REASON = 200;

export function emptyDenialLog(): DenialLog {
    return { recent: [], total: 0, lastAtMs: null, lastReason: null, sentAtMs: [] };
}

const lastHour = <T>(xs: T[], at: (x: T) => number, nowMs: number): T[] => xs.filter((x) => at(x) > nowMs - DENIAL_WINDOW_MS);

/** The log with one more denial, the ones older than the hour dropped. */
export function withDenial(log: DenialLog, atMs: number, reason: string | null, tool: string | null = null): DenialLog {
    const cut = reason && reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason;
    return {
        ...log,
        recent: [...lastHour(log.recent, (d) => d.atMs, atMs), { atMs, tool, reason: cut }],
        total: log.total + 1,
        lastAtMs: atMs,
        lastReason: cut,
    };
}

/** #3509 — the log with one more prompt sent for repeated denials. */
export function withDeniedPromptSent(log: DenialLog, atMs: number): DenialLog {
    return { ...log, sentAtMs: [...lastHour(log.sentAtMs, (t) => t, atMs), atMs] };
}

/** How many denials, and how many prompts sent, in the hour before `nowMs`. */
export function denialsInLastHour(log: DenialLog, nowMs: number): { denied: Denial[]; sent: number } {
    return { denied: lastHour(log.recent, (d) => d.atMs, nowMs), sent: lastHour(log.sentAtMs, (t) => t, nowMs).length };
}

/** As a host shows it (`agent.<id>.bar`'s `denials`); null when none came in the last hour. */
export interface DenialSummary {
    last_hour: number;
    total: number;
    last_at: string;
    last_reason: string | null;
    /** #3509 — the prompts the loop sent for repeated denials in the last hour. */
    sent: number;
}

export function denialSummary(log: DenialLog, nowMs: number): DenialSummary | null {
    const { denied, sent } = denialsInLastHour(log, nowMs);
    if (denied.length === 0 || log.lastAtMs === null) return null;
    return { last_hour: denied.length, total: log.total, last_at: new Date(log.lastAtMs).toISOString(), last_reason: log.lastReason, sent };
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
