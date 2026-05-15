/**
 * Decision-on-comment primitive (#B.129).
 *
 * A `comment_added` may carry an optional `meta.decision` block: the
 * author tags the comment as decisional (`kind`: plan / resolution /
 * extensible) and the reporter later accepts or rejects it.
 *
 * Stored in `messages.meta` (existing JSON sidecar, same field that
 * carries question answers from #B.104). String-pure helpers below
 * keep the data on one side and the DB / API plumbing on the other.
 *
 * Q1 retained: author tags at post-time (composer dropdown).
 * Q2 retained: this primitive will eventually subsume `ticket_resolved`
 *              — historical events stay readable, new flows emit a
 *              comment with `decision.kind="resolution"`. (Migration
 *              happens in the next phase.)
 * Q3 retained: most-recent-pending-decision wins. No order enforcement.
 * Q4 retained: v1 kinds = `plan` | `resolution`. `blocked` stays a
 *              separate lifecycle event (it's a signal, not a vote).
 */

export const DECISION_KINDS = ["plan", "resolution"] as const;
export type DecisionKind = typeof DECISION_KINDS[number];

export const DECISION_STATUSES = ["pending", "accepted", "rejected"] as const;
export type DecisionStatus = typeof DECISION_STATUSES[number];

export interface CommentDecision {
    kind: DecisionKind;
    status: DecisionStatus;
    /** Filled when status transitions to accepted/rejected. */
    decided_by?: string;
    decided_at?: string;
}

export function isDecisionKind(s: string): s is DecisionKind {
    return (DECISION_KINDS as readonly string[]).includes(s);
}

export function isDecisionStatus(s: string): s is DecisionStatus {
    return (DECISION_STATUSES as readonly string[]).includes(s);
}

/**
 * Apply an accept/reject to an existing decision sidecar. Returns the
 * new decision block and whether anything changed (idempotent: re-
 * applying the same status is a no-op).
 *
 * Throws when the decision can't be promoted (no decision present,
 * already terminal in a different direction). Callers should turn
 * these into 4xx responses.
 */
export function applyDecision(
    current: CommentDecision | undefined,
    next: DecisionStatus,
    by: string,
    at: string,
    /** Optional reclassification (#B.129 follow-up): the reporter can
     *  change the decision kind at the moment of accepting/rejecting
     *  — e.g. "this was tagged as a resolution but it's really just
     *  a plan, accept it as a plan". Without this, the kind stays
     *  whatever the author originally chose. */
    newKind?: DecisionKind,
): { decision: CommentDecision; changed: boolean } {
    if (!current) {
        throw new Error("no decision on this message — author must tag it first");
    }
    if (next === "pending") {
        throw new Error("cannot reset a decision to pending");
    }
    const effectiveKind = newKind ?? current.kind;
    if (current.status === next && effectiveKind === current.kind) {
        return { decision: current, changed: false };
    }
    if (current.status !== "pending") {
        throw new Error(
            `decision already ${current.status} — re-tagging requires a new comment`,
        );
    }
    return {
        decision: {
            kind: effectiveKind,
            status: next,
            decided_by: by,
            decided_at: at,
        },
        changed: true,
    };
}
