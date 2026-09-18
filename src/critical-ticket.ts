/**
 * #2770 david — "parfois un vieux ticket bloque tout le monde : ça peut être
 * bien de l'annoncer quand on n'a plus d'event et avant le backlog".
 *
 * A project's critical ticket is the open ticket that holds back the most open
 * tickets, following `depends_on` / `blocks` from one to the next: if A waits on
 * B and B waits on C, C holds both. It is an indicator: the wake names it, the
 * agent judges.
 *
 * Pure: the edges are read from relation rows, the rest through functions the
 * caller passes in.
 */

/** A `ticket_relation` event: the ticket it is on, the ticket it names, its meta. */
export interface RelationRow {
    sourceTicketId: number;
    targetTicketId: number | null;
    meta: string | null;
}

/** `waiter` cannot move until `blocker` closes. */
export interface GateEdge {
    waiter: number;
    blocker: number;
}

/**
 * Who waits on whom, from the latest relation event of each (source, target)
 * pair. `depends_on`: the source waits on the target; `blocks`: the target
 * waits on the source. The same reading the actionable gate uses.
 */
export function gateEdges(rows: readonly RelationRow[]): GateEdge[] {
    const latest = new Map<string, { source: number; target: number; kind: string }>();
    for (const r of rows) {
        if (!r.meta || !r.targetTicketId) continue;
        let kind: string | undefined;
        try {
            kind = (JSON.parse(r.meta) as { relation?: { kind?: string } }).relation?.kind;
        } catch { continue; }
        if (!kind) continue;
        latest.set(`${r.sourceTicketId}-${r.targetTicketId}`, { source: r.sourceTicketId, target: r.targetTicketId, kind });
    }
    const out: GateEdge[] = [];
    for (const r of latest.values()) {
        if (r.kind === "depends_on") out.push({ waiter: r.source, blocker: r.target });
        else if (r.kind === "blocks") out.push({ waiter: r.target, blocker: r.source });
    }
    return out;
}

/** Below this, a ticket holding one other is ordinary sequencing, not news. */
export const CRITICAL_MIN_HOLDS = 2;

export interface CriticalPick {
    id: number;
    /** Open tickets held back, directly or down a chain. */
    holds: number;
}

/**
 * The open ticket among `candidates` that holds back the most open tickets —
 * at least `CRITICAL_MIN_HOLDS` — or null. A tie goes to the one that has not
 * moved for longest.
 */
export function pickCritical(
    edges: readonly GateEdge[],
    isOpen: (id: number) => boolean,
    isCandidate: (id: number) => boolean,
    lastMovedMs: (id: number) => number,
): CriticalPick | null {
    const waitersOf = new Map<number, number[]>();
    for (const e of edges) {
        if (!isOpen(e.waiter) || !isOpen(e.blocker)) continue;
        const list = waitersOf.get(e.blocker);
        if (list) list.push(e.waiter);
        else waitersOf.set(e.blocker, [e.waiter]);
    }
    let best: CriticalPick | null = null;
    for (const id of waitersOf.keys()) {
        if (!isCandidate(id)) continue;
        const held = new Set<number>();
        const queue = [id];
        while (queue.length) {
            for (const w of waitersOf.get(queue.pop()!) ?? []) {
                if (w === id || held.has(w)) continue;
                held.add(w);
                queue.push(w);
            }
        }
        if (held.size < CRITICAL_MIN_HOLDS) continue;
        if (!best || held.size > best.holds || (held.size === best.holds && lastMovedMs(id) < lastMovedMs(best.id))) {
            best = { id, holds: held.size };
        }
    }
    return best;
}

/** `3 d` once it has been quiet a full day; "" before that. */
export function quietFor(lastMovedMs: number, nowMs: number): string {
    const days = Math.floor((nowMs - lastMovedMs) / 86_400_000);
    return Number.isFinite(days) && days >= 1 ? `${days} d` : "";
}
