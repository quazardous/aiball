// #374 — pure logic of the per-consumer "whose court" gate (last_actor +
// sole-participant), extracted from projects.ts so it unit-tests without a DB
// (façon decision-gate.ts). ZERO imports on purpose — the test file stays pure.
//
// See docs/TICKET_LIFECYCLE.md §4. The model: a ticket is excluded from
// consumer C's actionable pool iff C took the LAST action on it AND a
// counterpart exists (someone other than C also acted). When C is the sole
// participant (their own un-answered task), it stays actionable.

/**
 * Event kinds that count as an "action" on a ticket (move whose-court).
 * Comments + lifecycle. Structural events (ticket_relation / ticket_sub_added /
 * ticket_referenced) and the `ticket_created` root (handled separately as the
 * creator) are NOT here. Single source of truth — connection.ts (backfill) and
 * projects.ts (foreign-actor scan) both import this.
 */
export const LAST_ACTOR_ACTION_KINDS: ReadonlySet<string> = new Set([
    "comment_added", "ticket_closed", "ticket_reopened", "ticket_resolved", "ticket_blocked",
]);

/**
 * Is `actor` a real foreign actor relative to `consumerId`? False for the
 * consumer itself, the `auto` moderation marker, and null/empty (an
 * auto-approved comment's actor is its author, supplied by the caller).
 */
export function isForeignActor(actor: string | null | undefined, consumerId: string): boolean {
    return !!actor && actor !== "auto" && actor !== consumerId;
}

/** One ticket event, reduced to what the gate cares about. */
export interface ActorEvent {
    kind: string;
    byAgent: string | null;
    /** meta.decision.status, when this comment carries a decision. */
    decisionStatus?: string | null;
    /** meta.decision.decided_by, when this comment carries a decision. */
    decidedBy?: string | null;
}

/**
 * Does this event represent an action by someone OTHER than `consumerId`?
 * True for: an action-kind authored by a foreign actor, OR a settled
 * (accepted/rejected) decision decided by a foreign actor. The decider counts
 * even though accept/reject mutates an existing comment rather than appending
 * an event (#374) — that's exactly what makes a human accept/reopen hand the
 * ball back.
 */
export function eventHasForeignActor(ev: ActorEvent, consumerId: string): boolean {
    if (LAST_ACTOR_ACTION_KINDS.has(ev.kind) && isForeignActor(ev.byAgent, consumerId)) {
        return true;
    }
    if ((ev.decisionStatus === "accepted" || ev.decisionStatus === "rejected")
        && isForeignActor(ev.decidedBy, consumerId)) {
        return true;
    }
    return false;
}

/**
 * §4.1 exclusion predicate: C is gated out of its actionable pool iff C is the
 * ticket's last actor AND a counterpart exists. `lastActor === consumerId` with
 * no foreign actor = sole participant (own backlog) → kept (returns false).
 */
export function isExcludedForConsumer(
    lastActor: string | null,
    hasForeignActor: boolean,
    consumerId: string,
): boolean {
    return lastActor === consumerId && hasForeignActor;
}
