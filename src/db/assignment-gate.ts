// #418 — pure logic of the assignment exclusion, extracted so it unit-tests
// without a DB (façon last-actor-gate.ts / decision-gate.ts). ZERO imports on
// purpose — the test file stays pure.
//
// See docs/TICKET_LIFECYCLE.md §4 (gate). The model: a ticket with a LIVE
// assignment to someone OTHER than consumer C is dropped from C's actionable
// pool (multi-agent anti-collision). "Live" = still within the assign window
// (now − assigned_at < window). Unassigned OR expired → NOT excluded here; the
// ticket falls through to the normal last_actor gate (the shared pool). The
// assignee's own path is unchanged: an assignment only RESTRICTS visibility to
// the assignee — it never un-gates the assignee's own awaiting-someone state.

/** Is an assignment still within its live window? `windowMs` in MILLISECONDS. */
export function isAssignmentLive(
    assignedAt: string | null | undefined,
    nowMs: number,
    windowMs: number,
): boolean {
    if (!assignedAt) return false;
    const t = Date.parse(assignedAt);
    if (Number.isNaN(t)) return false;
    return nowMs - t < windowMs;
}

/**
 * Is this ticket assigned-AWAY from consumer C — i.e. live-assigned to someone
 * else? Such a ticket leaves C's actionable pool. Returns false when the ticket
 * is unassigned, assigned to C itself, or the window has expired (it then
 * behaves like a normal pool ticket). `windowMs` in MILLISECONDS.
 */
export function isAssignedAway(
    assignee: string | null | undefined,
    assignedAt: string | null | undefined,
    consumerId: string,
    nowMs: number,
    windowMs: number,
): boolean {
    if (!assignee || assignee === consumerId) return false;
    return isAssignmentLive(assignedAt, nowMs, windowMs);
}
