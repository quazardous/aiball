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
 * #2757 david — a ticket in the list can bring its relatives along:
 * `123+` its direct children, `123++` all its descendants, `+123` / `++123` the
 * same upward, `123~` every ticket directly linked to it. The list is expanded
 * when the focus is applied, not when it is typed: a sub-ticket filed later
 * under 123 is in `123+` from then on.
 *
 * Pure: parsing, expansion (the relations are read through a function the
 * caller passes in), the active check and the per-ticket verdict. The storage
 * (a project preference) and the rule that applies it live elsewhere.
 */

/** How far a ticket reaches along one direction: not at all, one step, or all the way. */
export type Reach = 0 | 1 | "all";

/** One entry of the focus list, as typed. */
export interface FocusSpec {
    id: number;
    /** Parents (`+123` one, `++123` all). */
    up: Reach;
    /** Children (`123+` one, `123++` all). */
    down: Reach;
    /** `123~`: every ticket directly linked to it, whatever the relation. */
    linked: boolean;
}

export interface WakeFocus {
    /** `only` = just these tickets; `except` = everything but them. */
    mode: "only" | "except";
    /** The tickets the list resolves to, relatives included. */
    ids: ReadonlySet<number>;
    /** The list as typed, for describing it. */
    specs: readonly FocusSpec[];
    /** ISO end, after which the focus no longer applies; null = until cleared. */
    until: string | null;
}

/** What the project stores: the text as typed, and the optional end. */
export interface StoredWakeFocus {
    tickets: string;
    until: string | null;
}

/** A ticket's relatives, one step away. */
export interface FocusRelatives {
    children: number[];
    parents: number[];
    linked: number[];
}

/** Reads one ticket's relatives. Absent: no expansion (the list is taken literally). */
export type RelativesOf = (id: number) => FocusRelatives;

const REACH_OF: Record<string, Reach> = { "": 0, "+": 1, "++": "all" };

/**
 * Parse the ticket list. `123, 456` (or `#123 #456`) = only these;
 * `!789, !790` = all but these. Mixing both forms is refused: "only 123 but
 * not 789" says nothing `123` alone does not. Each ticket may carry
 * `+`/`++` before it (parents), and `+`/`++` or `~` after it (children, linked).
 */
export function parseFocusTickets(text: string): { mode: "only" | "except"; ids: number[]; specs: FocusSpec[] } | { error: string } {
    const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return { error: "the focus lists no ticket" };
    const only: FocusSpec[] = [];
    const except: FocusSpec[] = [];
    for (const tok of tokens) {
        const m = /^(!)?(\+\+|\+)?#?(\d+)(\+\+|\+|~)?$/.exec(tok);
        if (!m) {
            return {
                error: `"${tok}" is not a ticket: write 123 or #123; 123+ adds its children, 123++ all its descendants, `
                    + `+123 / ++123 its parents, 123~ the tickets linked to it; !123 leaves one out`,
            };
        }
        const suffix = m[4] ?? "";
        const spec: FocusSpec = {
            id: Number(m[3]),
            up: REACH_OF[m[2] ?? ""],
            down: suffix === "~" ? 0 : REACH_OF[suffix],
            linked: suffix === "~",
        };
        (m[1] ? except : only).push(spec);
    }
    if (only.length && except.length) {
        return { error: "the focus mixes tickets to keep (123) and to leave out (!789) — use one form" };
    }
    const specs = only.length ? only : except;
    return { mode: only.length ? "only" : "except", ids: [...new Set(specs.map((s) => s.id))], specs };
}

/** Follow one direction from `id` as far as `reach` says, collecting what is met. */
function walk(id: number, reach: Reach, step: (id: number) => number[], into: Set<number>): void {
    if (reach === 0) return;
    let frontier = [id];
    const seen = new Set<number>([id]);
    for (let depth = 0; frontier.length && (reach === "all" || depth < reach); depth++) {
        const next: number[] = [];
        for (const t of frontier) {
            for (const r of step(t)) {
                if (seen.has(r)) continue;
                seen.add(r);
                into.add(r);
                next.push(r);
            }
        }
        frontier = next;
    }
}

/** The tickets `specs` resolve to. Without `relativesOf`, only the tickets named. */
export function expandFocus(specs: readonly FocusSpec[], relativesOf?: RelativesOf): Set<number> {
    const out = new Set<number>(specs.map((s) => s.id));
    if (!relativesOf) return out;
    const memo = new Map<number, FocusRelatives>();
    const rel = (id: number): FocusRelatives => {
        let r = memo.get(id);
        if (!r) { r = relativesOf(id); memo.set(id, r); }
        return r;
    };
    for (const s of specs) {
        walk(s.id, s.down, (id) => rel(id).children, out);
        walk(s.id, s.up, (id) => rel(id).parents, out);
        if (s.linked) for (const r of rel(s.id).linked) out.add(r);
    }
    return out;
}

/** The focus in force at `nowMs`, or null: none stored, unparsable, or past its end. */
export function activeFocus(stored: StoredWakeFocus | null | undefined, nowMs: number, relativesOf?: RelativesOf): WakeFocus | null {
    if (!stored || !stored.tickets.trim()) return null;
    if (stored.until) {
        const end = Date.parse(stored.until);
        if (Number.isFinite(end) && end <= nowMs) return null;
    }
    const parsed = parseFocusTickets(stored.tickets);
    if ("error" in parsed) return null;
    return { mode: parsed.mode, ids: expandFocus(parsed.specs, relativesOf), specs: parsed.specs, until: stored.until };
}

/** Does `focus` keep ticket `id` from waking the agent? */
export function focusHides(focus: WakeFocus | null | undefined, id: number): boolean {
    if (!focus) return false;
    return focus.mode === "only" ? !focus.ids.has(id) : focus.ids.has(id);
}

/** One spec as it reads: `#123`, `#123++`, `+#123`, `#123~`. */
function specRef(s: FocusSpec): string {
    const pre = s.up === "all" ? "++" : s.up === 1 ? "+" : "";
    const post = s.linked ? "~" : s.down === "all" ? "++" : s.down === 1 ? "+" : "";
    return `${pre}#${s.id}${post}`;
}

/** The line a wake opens with, so the agent knows why it sees only part of its work. */
export function describeFocus(focus: WakeFocus | null | undefined): string {
    if (!focus) return "";
    const refs = [...focus.specs].sort((a, b) => a.id - b.id).map(specRef).join(", ");
    return focus.mode === "only" ? `focus: ${refs} only` : `focus: all but ${refs}`;
}
