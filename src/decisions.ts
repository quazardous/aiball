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

// #802 — `wontfix` joined the set : an agent triaging a junk / out-of-scope /
// non-reproducible ticket can propose closure WITHOUT resolution via
// `ticket_reply({then:"wontfix"})`. Symmetric to `resolution` (pending = gated,
// reporter accept/reject) but accepting it ALSO auto-closes the ticket without
// flipping `resolved` — the ticket lands in `closed` state with no
// `resolved_by` / `resolved_at`. The acceptance side-effect lives in the
// api/messages.ts decide handler, NOT in this pure module.
// #737 — `escalation` joined the set : an agent that hits a blocker
// requiring human action (repo admin, infra, policy decision) posts
// `ticket_reply({then:"escalate"})`. Pending = ticket gated (the agent
// waits) ; accept = the human did the action (ticket re-enters actionable
// so the agent can continue any remaining work — NO auto-close, the ticket
// is not "done", just unblocked) ; reject = the human says "not an
// escalation" (ticket re-enters actionable, agent can re-classify).
// Gate semantics mirror `plan` (also a "waiting on someone" signal). At-
// insert side-effect : bumps the parent ticket's priority one notch
// (low→high, normal→high, high→urgent, urgent stays) so the human sees
// it at the top of their inbox. The bump lives in db/messages.ts insert
// path, NOT in this pure module.
export const DECISION_KINDS = ["plan", "resolution", "wontfix", "escalation"] as const;
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
/**
 * Reclassify the kind of a pending decision WITHOUT accepting/rejecting
 * (#B.129 follow-up): "the agent tagged this as resolution but it's
 * really a plan — keep it pending, just change the verb". Throws when
 * the decision is missing or already terminal.
 */
export function reclassifyDecision(
    current: CommentDecision | undefined,
    newKind: DecisionKind,
): { decision: CommentDecision; changed: boolean } {
    if (!current) {
        throw new Error("no decision on this message — author must tag it first");
    }
    if (current.status !== "pending") {
        throw new Error(
            `decision already ${current.status} — reclassify requires the decision to still be pending`,
        );
    }
    if (current.kind === newKind) {
        return { decision: current, changed: false };
    }
    return {
        decision: { ...current, kind: newKind },
        changed: true,
    };
}

/**
 * Promote an undecorated comment into a decision (#B.256). Differs
 * from `reclassifyDecision` / `applyDecision`: those throw when the
 * comment has no prior decision, since reclassify/decide both assume
 * a decision exists. `promoteToDecision` is the post-hoc tag flow —
 * the reporter looks at a regular comment and either marks it as a
 * pending proposal (`status` omitted → pending) or as already-
 * accepted (`status="accepted"` → tagged + decided in one shot).
 *
 * If a decision already exists on the comment, this delegates to
 * the existing helpers so the API surface is symmetric:
 *   - `status` undefined → reclassify (kind only, must stay pending).
 *   - `status` set        → applyDecision (kind + final status).
 *
 * Returns the new decision block + whether anything changed (no-op
 * when the target state matches what's already there).
 */
export function promoteToDecision(
    current: CommentDecision | undefined,
    kind: DecisionKind,
    status?: Exclude<DecisionStatus, "pending">,
    by?: string,
    at?: string,
): { decision: CommentDecision; changed: boolean } {
    if (current) {
        if (status === undefined) {
            return reclassifyDecision(current, kind);
        }
        if (by === undefined || at === undefined) {
            throw new Error("promote with status= requires `by` and `at`");
        }
        return applyDecision(current, status, by, at, kind);
    }
    if (status === undefined) {
        return {
            decision: { kind, status: "pending" },
            changed: true,
        };
    }
    if (by === undefined || at === undefined) {
        throw new Error("promote with status= requires `by` and `at`");
    }
    return {
        decision: {
            kind,
            status,
            decided_by: by,
            decided_at: at,
        },
        changed: true,
    };
}

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
