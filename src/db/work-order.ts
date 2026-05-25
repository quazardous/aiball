/**
 * #371 + #402 — the work-order comparator, extracted PURE so the shared sort is
 * unit-testable (same shape as decision-gate.ts / landscape.ts).
 *
 * A ticket_list comes back as a WORK LANDSCAPE. Ordering keys, outer→inner:
 *   1. **tier** (greedy, each ticket in its highest): 0 unread → 1 actionable
 *      (¬unread) → 2 other open → 3 the rest (closed/snoozed).
 *   2. **priority** desc (urgent→low) — the strongest sort WITHIN a tier
 *      (david `xkehmv`: « priorité est le tri le plus fort »).
 *   3. **own claim** (#430) — at EQUAL priority, a ticket the consumer holds a
 *      LIVE claim on (their explicit focus) sorts first, ABOVE hot. The claim is
 *      a stronger "what I'm on" signal than hot's recent-activity proxy: it's
 *      intentional and survives a quiet stretch (thinking / reading context),
 *      whereas hot decays after the hot window. Stays WITHIN the tier.
 *   4. **hot** (#402 levier 1) — at EQUAL priority + no own-claim distinction, a
 *      ticket in the consumer's *hot-zone* (their own recent activity, see
 *      TICKET_LIFECYCLE.md) sorts first, so the wake follows the active
 *      conversation instead of a stale oldest head. Stays WITHIN the tier.
 *   5. **oldest** (id asc) — final tiebreak.
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
    /** #430: does the consumer hold a LIVE claim on this ticket? (explicit focus,
     *  sorts above hot). Optional — omitted ⇒ no claim distinction (back-compat). */
    isOwnClaim?: (id: number) => boolean;
    /** #436 (decision 4): is this ticket ASSIGNED to the consumer (a human handed
     *  it to them)? Sorts below own-claim (current focus) but above hot — what
     *  you've been handed outranks a stale-activity guess. Optional (back-compat). */
    isAssignedToMe?: (id: number) => boolean;
}

/** Pure comparator: tier → priority desc → own-claim → assigned-to-me → hot → oldest. */
export function compareWorkOrder(a: WorkOrderRow, b: WorkOrderRow, ctx: WorkOrderCtx): number {
    const tA = ctx.tierOf(a.id);
    const tB = ctx.tierOf(b.id);
    if (tA !== tB) return tA - tB;
    const wA = ctx.priorityWeight(a.priority);
    const wB = ctx.priorityWeight(b.priority);
    if (wA !== wB) return wB - wA; // priority desc — strongest sort within a tier
    // #430: own live claim = explicit focus, sorts before hot (implicit/decaying).
    const cA = ctx.isOwnClaim?.(a.id) ? 1 : 0;
    const cB = ctx.isOwnClaim?.(b.id) ? 1 : 0;
    if (cA !== cB) return cB - cA;
    // #436 (4): assigned-to-me (handed to you) sorts below own-claim, above hot.
    const gA = ctx.isAssignedToMe?.(a.id) ? 1 : 0;
    const gB = ctx.isAssignedToMe?.(b.id) ? 1 : 0;
    if (gA !== gB) return gB - gA;
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

/**
 * #405 — the consumer's HOT-ZONE (focus), from their per-ticket self-activity.
 * Mono-focus today: the SINGLE most-recently self-touched ticket within the hot
 * window (david `garkc8`: "la fenêtre se ferme quand la suivante s'ouvre" → the
 * latest activity IS the focus; moving to another ticket closes the previous).
 * Returned as a **Set** so going multi-hotzone later (david `5qgx2w`) is just a
 * fill-policy change here — the consumers (sort tiebreak, `hot` flag, the wake
 * gate) already iterate the set. Empty when no self-activity is within the window.
 */
export function computeHotFocus(selfActivity: Map<number, string>, nowMs: number, windowMs: number): Set<number> {
    let focusId = -1;
    let focusTs = -Infinity;
    for (const [id, iso] of selfActivity) {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) continue;
        if (nowMs - t < windowMs && t > focusTs) { focusTs = t; focusId = id; }
    }
    return focusId > 0 ? new Set([focusId]) : new Set<number>();
}
