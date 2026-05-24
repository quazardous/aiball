/**
 * #371 + #402 — the work-order comparator, extracted PURE so the shared sort is
 * unit-testable (same shape as decision-gate.ts / landscape.ts).
 *
 * A ticket_list comes back as a WORK LANDSCAPE. Ordering keys, outer→inner:
 *   1. **tier** (greedy, each ticket in its highest): 0 unread → 1 actionable
 *      (¬unread) → 2 other open → 3 the rest (closed/snoozed).
 *   2. **priority** desc (urgent→low) — the strongest sort WITHIN a tier
 *      (david `xkehmv`: « priorité est le tri le plus fort »).
 *   3. **hot** (#402 levier 1) — at EQUAL priority, a ticket in the requesting
 *      consumer's *hot-zone* (their own recent activity, see TICKET_LIFECYCLE.md)
 *      sorts first, so the wake follows the active conversation instead of a
 *      stale oldest head. Stays WITHIN the tier — never crosses unread/actionable.
 *   4. **oldest** (id asc) — final tiebreak.
 */

export type Tier = number;

export interface WorkOrderRow {
    id: number;
    priority?: string | null;
}

export interface WorkOrderCtx {
    /** Highest tier the ticket qualifies for: 0 unread, 1 actionable, 2 open, 3 rest. */
    tierOf: (id: number) => Tier;
    /** Numeric weight for a priority label (higher = more urgent). */
    priorityWeight: (priority: string | null | undefined) => number;
    /** #402: is the ticket in the requesting consumer's hot-zone right now? */
    isHot: (id: number) => boolean;
}

/** Pure comparator: tier → priority desc → hot → oldest. */
export function compareWorkOrder(a: WorkOrderRow, b: WorkOrderRow, ctx: WorkOrderCtx): number {
    const tA = ctx.tierOf(a.id);
    const tB = ctx.tierOf(b.id);
    if (tA !== tB) return tA - tB;
    const wA = ctx.priorityWeight(a.priority);
    const wB = ctx.priorityWeight(b.priority);
    if (wA !== wB) return wB - wA; // priority desc — strongest sort within a tier
    const hA = ctx.isHot(a.id) ? 1 : 0;
    const hB = ctx.isHot(b.id) ? 1 : 0;
    if (hA !== hB) return hB - hA; // #402: hot first, only at equal priority
    return a.id - b.id; // oldest first
}

/** #402: a ticket is "hot" iff the consumer's own last activity on it is within
 *  the hot window. Pure (clock + window injected) so it tests without a DB. */
export function isWithinHotWindow(lastActivityIso: string | undefined | null, nowMs: number, windowMs: number): boolean {
    if (!lastActivityIso) return false;
    const t = Date.parse(lastActivityIso);
    if (Number.isNaN(t)) return false;
    return nowMs - t < windowMs;
}
