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

/**
 * #436: is this ticket HELD by someone OTHER than consumer C — so it leaves C's
 * actionable pool (anti-collision)? Two distinct holds now (split from the #418
 * single field):
 *   - a LIVE CLAIM by another agent (focus lock, TRANSIENT — within the claim
 *     window `now − claimedAt < windowMs`); OR
 *   - an ASSIGNMENT to another consumer (responsibility, PERSISTENT — no expiry).
 * Either drops the ticket from C's pool. Held-by-C / unheld / an expired claim
 * with no assignment → not away (falls through to the last_actor gate).
 * Supersedes `isAssignedAway` (kept for back-compat). `windowMs` in MS.
 */
export function isHeldByOther(
    assignee: string | null | undefined,
    claimant: string | null | undefined,
    claimedAt: string | null | undefined,
    consumerId: string,
    nowMs: number,
    windowMs: number,
): boolean {
    if (claimant && claimant !== consumerId && isAssignmentLive(claimedAt, nowMs, windowMs)) return true;
    if (assignee && assignee !== consumerId) return true;
    return false;
}

/**
 * #439 one-focus — when a consumer self-claims (self-claim)
 * ticket `keepId`, decide which of their OTHER live claims to AUTO-RELEASE so an
 * agent holds ONE focus at a time instead of accumulating locks (each live claim
 * drops a ticket from every other agent's pool + boosts it in the holder's own
 * work-order). A claim is released only when it is a *bare pickup* — a DIFFERENT
 * ticket, still LIVE, that the consumer has NOT commented on since they grabbed
 * it (so zero work is lost). Claims they've actually worked (a self comment AFTER
 * `claimedAt`) are kept. Pure: caller supplies the claims, the consumer's own
 * last-activity per ticket, and the clock/window.
 *
 * `claims`: every ticket the consumer currently holds a claim on ({id, claimedAt}).
 * `selfLastActivityMs`: ticketId → epoch-ms of the consumer's most-recent message
 *   on that ticket (absent = never commented). `windowMs` in MILLISECONDS.
 * Returns the ids to release (subset of `claims`, never including `keepId`).
 *
 * The `>=` (not `>`) is deliberate: posting an approved comment AUTO-CLAIMS the
 * ticket (#418 discipline A, `messages.ts`), so a *worked* ticket's `claimed_at`
 * equals the consumer's latest comment timestamp — `lastMs == claimedMs`. A
 * *bare* pickup (engage/assign with no comment) has `claimed_at` = the engage
 * time, strictly AFTER any pre-existing comment (or none at all) → `lastMs <
 * claimedMs` (or undefined) → released. So `>=` keeps comment-claims (worked) and
 * drops engage-claims-without-comment (bare).
 */
export function claimsToAutoRelease(
    claims: { id: number; claimedAt: string | null | undefined }[],
    selfLastActivityMs: Map<number, number>,
    keepId: number,
    nowMs: number,
    windowMs: number,
): number[] {
    const out: number[] = [];
    for (const c of claims) {
        if (c.id === keepId) continue; // never drop the ticket being engaged
        if (!isAssignmentLive(c.claimedAt, nowMs, windowMs)) continue; // expired → already out of pools
        const claimedMs = c.claimedAt ? Date.parse(c.claimedAt) : NaN;
        const lastMs = selfLastActivityMs.get(c.id);
        const workedSinceClaim =
            lastMs !== undefined && !Number.isNaN(claimedMs) && lastMs >= claimedMs;
        if (!workedSinceClaim) out.push(c.id); // bare pickup → release
    }
    return out;
}

/**
 * #439 token attribution — given the consumer's current claims, pick the ticket a
 * turn's tokens should be attributed to: the MOST-RECENTLY-CLAIMED LIVE claim
 * (max `claimedAt` within the window). This is the DURABLE focus anchor — robust
 * to an incidental ticket-scoped write elsewhere in the turn flipping the
 * volatile `active-ticket` marker (the pre-#439 anchor). Returns null when the
 * consumer holds no live claim, so the caller falls back to the marker. With
 * #439 one-focus, bare prior claims are already released; among any surviving
 * WORKED claims the most-recently-claimed is taken as the current focus. Pure.
 * `windowMs` in MILLISECONDS.
 */
export function pickFocusClaim(
    claims: { id: number; claimedAt: string | null | undefined }[],
    nowMs: number,
    windowMs: number,
): number | null {
    let best: { id: number; ms: number } | null = null;
    for (const c of claims) {
        if (!isAssignmentLive(c.claimedAt, nowMs, windowMs)) continue;
        const ms = Date.parse(c.claimedAt as string);
        if (Number.isNaN(ms)) continue;
        if (!best || ms > best.ms) best = { id: c.id, ms };
    }
    return best ? best.id : null;
}
