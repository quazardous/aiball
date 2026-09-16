/**
 * #2645 — how the consumer pages word an agent's wait credit (#2640). Pure, so
 * a plain Node test pins it.
 */
export interface WaitCreditRow {
    project: string;
    balance: number;
    earned: number;
    spent: number;
    refunded: number;
}

export interface WaitCreditMove {
    id: number;
    project: string;
    kind: string;
    minutes: number;
    ticket_id: number | null;
    ref: string | null;
    requested: number | null;
    created_at: string;
}

/** The list cell: the balance summed over projects, or a dash when there is nothing to show. */
export function creditCell(rows: WaitCreditRow[] | null | undefined): { text: string; sort: number } {
    if (!rows) return { text: "—", sort: -1 };
    if (rows.length === 0) return { text: "", sort: 0 };
    const total = rows.reduce((s, r) => s + r.balance, 0);
    return { text: `${total} min`, sort: total };
}

/** The list tooltip: one line per project. */
export function creditTooltip(rows: WaitCreditRow[] | null | undefined): string {
    if (!rows) return "A human has no wait credit";
    if (rows.length === 0) return "No movement yet: every project starts at its configured credit";
    return rows
        .map((r) => `${r.project}: ${r.balance} min (earned ${r.earned}, spent ${r.spent}, refunded ${r.refunded})`)
        .join("\n");
}

/** One movement, as a sentence. */
export function moveLabel(m: WaitCreditMove): string {
    const signed = `${m.minutes > 0 ? "+" : ""}${m.minutes} min`;
    const ticket = m.ticket_id !== null ? ` #${m.ticket_id}` : "";
    switch (m.kind) {
        case "earn_resolved": return `${signed} — ticket${ticket} closed on its accepted resolution`;
        case "earn_wontfix": return `${signed} — ticket${ticket} closed on its accepted wontfix`;
        case "earn_commit": return `${signed} — commit ${(m.ref ?? "").slice(0, 7)}${ticket ? ` on${ticket}` : ""}`;
        case "spend": {
            const capped = m.requested !== null && m.requested > -m.minutes ? ` (asked ${m.requested})` : "";
            return `${signed} — wait on${ticket}${capped}`;
        }
        case "refund": return `${signed} — back early on${ticket}`;
        default: return `${signed} — ${m.kind}${ticket}`;
    }
}
