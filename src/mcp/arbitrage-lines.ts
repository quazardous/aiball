/**
 * #2198 — `arbitrage` as an index an agent can skim, not a JSON dump.
 *
 * Measured on the live board before the change: 49 pending decisions, 52 948
 * bytes, 64% of it `summary_until`. Each summary is written to be read ALONE,
 * as the state of one ticket; stacked 49 times in a triage list they drowned
 * the list itself. So the default is one line per decision, and the summaries
 * come back on request.
 *
 * What this must never do is lie about what is waiting. Every decision is
 * counted in the header, and when `limit` cuts the list the header says how
 * many are not shown: a shorter list that looks complete is worse than a long
 * one. Pure and import-free, so the rendering is testable without an MCP
 * server or a daemon.
 */
export interface ArbitrageRow {
    comment_hashid: string | null;
    ticket_id: number;
    ticket_title: string;
    ticket_project: string;
    decision_kind: string;
    proposed_by: string | null;
    created_at: string;
    summary_until: string | null;
    superseded?: boolean;
    superseded_by?: string | null;
}

export const ARBITRAGE_DEFAULT_LIMIT = 100;

export function renderArbitrage(
    rows: readonly ArbitrageRow[],
    opts: { full?: boolean; limit?: number } = {},
): { meta: string[]; lines: string[] } {
    const total = rows.length;
    const shown = rows.slice(0, opts.limit ?? ARBITRAGE_DEFAULT_LIMIT);
    const superseded = rows.filter((r) => r.superseded).length;

    const meta = [
        `${total} pending decision${total === 1 ? "" : "s"} on tickets you report`
            + (superseded > 0 ? ` — ${total - superseded} to answer, ${superseded} superseded` : ""),
    ];
    if (shown.length < total) {
        meta.push(`showing ${shown.length} of ${total} — ${total - shown.length} not shown, raise limit to see them`);
    }
    if (!opts.full && shown.some((r) => r.summary_until)) {
        meta.push("summary_until left out — pass full: true to print it under each decision");
    }

    const locator = (r: ArbitrageRow) => `#${r.ticket_id}${r.comment_hashid ? `:${r.comment_hashid}` : ""}`;
    const width = Math.max(0, ...shown.map((r) => locator(r).length));
    const kindWidth = Math.max(0, ...shown.map((r) => r.decision_kind.length));
    const lines: string[] = [];
    for (const r of shown) {
        lines.push(
            [
                `${locator(r).padEnd(width)}  ${r.decision_kind.padEnd(kindWidth)}`,
                r.ticket_project,
                r.proposed_by ?? "?",
                r.created_at.slice(0, 10),
                r.ticket_title,
            ].join(" · ")
            + (r.superseded ? ` · superseded by ${r.superseded_by ?? "a later decision"}` : ""),
        );
        if (opts.full && r.summary_until) {
            lines.push(`    ↳ ${r.summary_until.replace(/\s*\n\s*/g, " ")}`);
        }
    }
    return { meta, lines };
}
