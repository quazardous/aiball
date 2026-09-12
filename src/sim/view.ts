/**
 * One agent's seat on the simulated board: where each open ticket sits in its
 * backlog, what gates it, and what the agent's next wake would say.
 *
 * Pure, so a unit test holds the wake wording to the loop's own template
 * (src/claude-loop/state.ts, next to it) and the table to its rules.
 */

/** The flags `/api/tickets` computes for the consumer asking. */
export interface ViewRow {
    id: number;
    title: string;
    actionable: boolean;
    claimable: boolean;
    unread?: boolean;
    backlog_tier: 0 | 1 | 2 | 3 | 4 | null;
    gated_by_decision: boolean;
    last_actor: string | null;
    claimant?: string | null;
}

export const TIER_LABEL: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: "hot",
    1: "actionable",
    2: "follow-up",
    3: "waiting",
    4: "blocked",
};

/** How a backlog wake ends, by the head's tier — the loop's exact words. */
export const WAKE_ENDING = {
    triage: "Triage it, then close the loop: a `then:` (plan / continue / resolved), or a `handback: true` comment saying what you wait for.",
    followup: "Your pending decision gates this — re-examine the scope, then amend it with a fresher `then:`; an ack changes nothing.",
    waiting: "You spoke last — chase them or let it ride, but say which: a `then:` if the ball is yours, a `handback: true` comment naming what you wait for.",
    blocked: "Blocked by an open dependency — check the chain: help on the blocker, or cut the relation if it is stale. Say which on the thread.",
} as const;

/** Same mapping as the loop: unknown, hot or actionable heads are triaged. */
export function wakeEnding(tier: ViewRow["backlog_tier"]): string {
    if (tier === null || tier <= 1) return WAKE_ENDING.triage;
    if (tier === 2) return WAKE_ENDING.followup;
    if (tier === 3) return WAKE_ENDING.waiting;
    return WAKE_ENDING.blocked;
}

/**
 * What the next wake would be. Unread pings come first (an event wake); with
 * none, the backlog head the loop would pick; with no backlog, nothing.
 */
export function nextWake(unreadPings: number, head: ViewRow | null): string {
    if (unreadPings > 0) return `event wake: ${unreadPings} unread ping${unreadPings > 1 ? "s" : ""} first`;
    if (!head || head.backlog_tier === null) return "no wake: nothing in the backlog";
    return `look #${head.id}: ${head.title}. ${wakeEnding(head.backlog_tier)}`;
}

function cell(v: string, width: number): string {
    return v.length > width ? `${v.slice(0, width - 1)}…` : v.padEnd(width);
}

/** The seat as a table, backlog first (by tier), then the open tickets outside it. */
export function formatView(agent: string, rows: ViewRow[], unreadPings: number, head: ViewRow | null): string {
    const sorted = [...rows].sort((a, b) =>
        (a.backlog_tier ?? 9) - (b.backlog_tier ?? 9) || a.id - b.id);
    const lines = [
        `== ${agent} ==`,
        `next: ${nextWake(unreadPings, head)}`,
    ];
    if (sorted.length === 0) {
        lines.push("  (no open ticket)");
        return lines.join("\n");
    }
    lines.push(`  ${cell("#", 6)}${cell("backlog", 12)}${cell("act", 5)}${cell("claim", 7)}${cell("gated", 7)}${cell("last actor", 16)}title`);
    for (const r of sorted) {
        const mark = (b: boolean) => (b ? "yes" : "·");
        lines.push("  "
            + cell(String(r.id), 6)
            + cell(r.backlog_tier === null ? "—" : TIER_LABEL[r.backlog_tier], 12)
            + cell(mark(r.actionable), 5)
            + cell(mark(r.claimable), 7)
            + cell(mark(r.gated_by_decision), 7)
            + cell(r.last_actor ?? "—", 16)
            + r.title);
    }
    return lines.join("\n");
}
