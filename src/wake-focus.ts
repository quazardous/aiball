/**
 * #2525 david — "restreindre la visibilité du lead/owner à une liste de
 * tickets : temporairement, les backlog et events sont filtrés dans une liste
 * (list:123,456, ou tout sauf !789)".
 *
 * A project's wake focus narrows what may WAKE its owner agents — their backlog
 * and the events their loop drains — to a list of tickets, or to everything but
 * a list. It governs what wakes an agent, not what it may read: `ticket_get` and
 * an explicit `ticket_list` stay whole, and humans are never filtered. An event
 * on a ticket outside the focus stays unread, and reaches the agent once the
 * focus is lifted.
 *
 * Pure: parsing, the active check and the per-ticket verdict. The storage (a
 * project preference) and the rule that applies it live elsewhere.
 */

export interface WakeFocus {
    /** `only` = just these tickets; `except` = everything but them. */
    mode: "only" | "except";
    ids: ReadonlySet<number>;
    /** ISO end, after which the focus no longer applies; null = until cleared. */
    until: string | null;
}

/** What the project stores: the text as typed, and the optional end. */
export interface StoredWakeFocus {
    tickets: string;
    until: string | null;
}

/**
 * Parse the ticket list. `123, 456` (or `#123 #456`) = only these;
 * `!789, !790` = all but these. Mixing both forms is refused: "only 123 but
 * not 789" says nothing `123` alone does not.
 */
export function parseFocusTickets(text: string): { mode: "only" | "except"; ids: number[] } | { error: string } {
    const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return { error: "the focus lists no ticket" };
    const only: number[] = [];
    const except: number[] = [];
    for (const tok of tokens) {
        const m = /^(!)?#?(\d+)$/.exec(tok);
        if (!m) return { error: `"${tok}" is not a ticket: write 123 or #123, and !123 to leave one out` };
        (m[1] ? except : only).push(Number(m[2]));
    }
    if (only.length && except.length) {
        return { error: "the focus mixes tickets to keep (123) and to leave out (!789) — use one form" };
    }
    return only.length ? { mode: "only", ids: [...new Set(only)] } : { mode: "except", ids: [...new Set(except)] };
}

/** The focus in force at `nowMs`, or null: none stored, unparsable, or past its end. */
export function activeFocus(stored: StoredWakeFocus | null | undefined, nowMs: number): WakeFocus | null {
    if (!stored || !stored.tickets.trim()) return null;
    if (stored.until) {
        const end = Date.parse(stored.until);
        if (Number.isFinite(end) && end <= nowMs) return null;
    }
    const parsed = parseFocusTickets(stored.tickets);
    if ("error" in parsed) return null;
    return { mode: parsed.mode, ids: new Set(parsed.ids), until: stored.until };
}

/** Does `focus` keep ticket `id` from waking the agent? */
export function focusHides(focus: WakeFocus | null | undefined, id: number): boolean {
    if (!focus) return false;
    return focus.mode === "only" ? !focus.ids.has(id) : focus.ids.has(id);
}

/** The line a wake opens with, so the agent knows why it sees only part of its work. */
export function describeFocus(focus: WakeFocus | null | undefined): string {
    if (!focus) return "";
    const refs = [...focus.ids].sort((a, b) => a - b).map((id) => `#${id}`).join(", ");
    return focus.mode === "only" ? `focus: ${refs} only` : `focus: all but ${refs}`;
}
