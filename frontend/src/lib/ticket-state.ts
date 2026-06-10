/**
 * Pure predicates over an InboxRow. No side-effects, no API calls.
 *
 * These encode "what state is this ticket in?" in one auditable place so
 * the Vue components don't reinvent the rules (`r.closed && r.resolved`
 * vs `!r.closed && !r.postponed` vs …) in every template.
 *
 * Extracted from App.vue + InboxList.vue (#B.332 Phase D, per `#C.mf5h72`).
 */
import { type InboxRow } from "./api";

export function isPending(r: InboxRow): boolean {
    return r.status === "pending";
}

export function isApproved(r: InboxRow): boolean {
    return r.status === "approved";
}

export function isRejected(r: InboxRow): boolean {
    return r.status === "rejected";
}

export function isClosed(r: InboxRow): boolean {
    return r.closed === true;
}

export function isResolved(r: InboxRow): boolean {
    return r.resolved === true;
}

export function isBlocked(r: InboxRow): boolean {
    return r.blocked === true;
}

export function isSnoozed(r: InboxRow): boolean {
    return r.postponed === true;
}

/**
 * "Open" = the ticket is actively in the inbox, awaiting work. Means
 * approved, not closed, not snoozed. Pending tickets are not "open" —
 * they need moderation first.
 */
export function isOpen(r: InboxRow): boolean {
    return isApproved(r) && !isClosed(r) && !isSnoozed(r);
}

export function isUnread(r: InboxRow): boolean {
    return r.unread === true;
}

/**
 * Pick one lifecycle stage per ticket — the lead icon in the row uses
 * this directly so the cascade lives in one place.
 *
 * Priority order matters: a rejected ticket is rejected regardless of
 * any close/resolve event; a closed-resolved is more specific than
 * just closed; postponed is checked last because it's the most
 * transient state.
 */
export type LifecycleStage =
    | "rejected"
    | "closed-resolved"
    | "closed"
    | "resolved"
    | "pending-escalation"
    | "pending-resolved"
    | "pending-plan"
    | "rejected-resolved"
    | "rejected-plan"
    | "blocked"
    | "snoozed"
    | "open";

export function lifecycleStage(r: InboxRow): LifecycleStage {
    if (isRejected(r)) return "rejected";
    if (isClosed(r) && isResolved(r)) return "closed-resolved";
    if (isClosed(r)) return "closed";
    if (isResolved(r)) return "resolved";
    // #737 — pending escalation outranks resolution/plan : the agent is
    // explicitly demanding human action, surface it FIRST so the badge
    // wins over softer "awaiting your accept" framing. Modern, formal
    // path that supersedes the legacy `blocked` lifecycle event.
    if (r.pending_escalation) return "pending-escalation";
    // An agent proposed resolution but the reporter hasn't approved it
    // yet. Visually distinct from final-resolved so the reporter sees
    // there's a pending decision (#B.120).
    if (r.pending_resolution) return "pending-resolved";
    // #656 david: same surfacing for pending PLAN decisions. Lower
    // priority than pending-resolved (a pending resolution is "later
    // in the pipeline" — agent says done, awaiting accept) ; a pending
    // plan is "earlier" — agent proposes a direction, awaiting validate.
    if (r.pending_plan) return "pending-plan";
    // #B.168 follow-up: latest resolution was rejected and the thread
    // is still open — distinct red X badge so the reporter sees their
    // earlier rejection still leaves work on the table.
    if (r.latest_resolution_rejected) return "rejected-resolved";
    // #B.173: same surface for plan decisions. Lower priority than
    // rejected-resolved since a rejected resolution is "later in the
    // pipeline" (work was claimed done but reporter said no) while a
    // rejected plan is "earlier" (the proposed direction didn't fly).
    // Both can coexist in theory but the resolution wins the badge.
    if (r.latest_plan_rejected) return "rejected-plan";
    // Agent escalated — distinct from resolved because the human can't
    // just rubber-stamp; they need to look at it (#B.119).
    if (isBlocked(r)) return "blocked";
    if (isSnoozed(r)) return "snoozed";
    return "open";
}

/**
 * Row tint priority per the workflow design (#B148):
 *   moderation > resolution > comments > null
 * At most one accent per row, chosen by the most urgent action waiting
 * on the consumer. `null` = nothing to do, row stays neutral.
 */
export type Attention = "moderation" | "resolution" | "comments" | null;

export function attentionOf(r: InboxRow): Attention {
    if (isPending(r)) return "moderation";
    if (r.pending_resolution) return "resolution";
    // #656 david: same "resolution" tint for pending plans — both are
    // "decision pending on the reporter". Distinct icons / labels
    // surface the kind ; the row accent groups them as "your call".
    if (r.pending_plan) return "resolution";
    // #897 david dt3fj7 : pending escalation = action humaine attendue
    // (= "your call" aussi, même tint vert que plan/resolution). La rouge
    // ESCALATED reste via lifecycleStage="pending-escalation" → badge
    // urgence ; le liseré dit en plus "il faut que tu agisses sur cette
    // ligne dans ton inbox".
    if (r.pending_escalation) return "resolution";
    if (r.pending_comment_count > 0) return "comments";
    return null;
}
