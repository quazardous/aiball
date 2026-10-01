/**
 * #3480 — the events an agent may read but that never wake it (a ticket
 * another agent holds, #3449), carried in its next wake as one line, then
 * marked read. Without this, nothing ever delivered them: they stayed unread
 * for ever and the `events` counter only climbed.
 */

/** An unread event, as `unread.list` gives it. */
export interface FyiEvent {
    id: number;
    kind?: string | null;
    ticket_id?: number | null;
    project?: string | null;
}

/** At most this many tickets are named; the rest are counted. */
const MAX_TICKETS = 8;

/** What happened on one ticket, in a word or two. */
function said(kinds: string[]): string {
    const n = (k: string) => kinds.filter((x) => x === k).length;
    const parts: string[] = [];
    if (n("ticket_created")) parts.push("new");
    const comments = n("comment_added");
    if (comments) parts.push(comments > 1 ? `×${comments}` : "reply");
    if (n("ticket_closed")) parts.push("closed");
    if (n("ticket_reopened")) parts.push("reopened");
    const other = kinds.length - n("ticket_created") - comments - n("ticket_closed") - n("ticket_reopened");
    if (other) parts.push(other > 1 ? `${other} events` : "event");
    return parts.join(", ");
}

/**
 * The line, or "" with nothing to say. Grouped by ticket, the latest first,
 * each with its project: `FYI, no action asked: [tvty] #3454 ×3, closed · [tvty] #3479 new`.
 */
export function renderFyiLine(events: readonly FyiEvent[]): string {
    if (!events.length) return "";
    const byTicket = new Map<number, { project: string | null; kinds: string[]; last: number }>();
    for (const e of events) {
        const ticket = e.kind === "ticket_created" ? e.id : e.ticket_id ?? e.id;
        const g = byTicket.get(ticket) ?? { project: e.project ?? null, kinds: [], last: 0 };
        g.kinds.push(e.kind ?? "");
        g.last = Math.max(g.last, e.id);
        byTicket.set(ticket, g);
    }
    const tickets = [...byTicket.entries()].sort((a, b) => b[1].last - a[1].last);
    const shown = tickets.slice(0, MAX_TICKETS).map(([id, g]) => `${g.project ? `[${g.project}] ` : ""}#${id} ${said(g.kinds)}`);
    const more = tickets.length - shown.length;
    return `FYI, no action asked: ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}.`;
}
