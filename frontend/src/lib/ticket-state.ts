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
    | "pending-resolved"
    | "snoozed"
    | "open";

export function lifecycleStage(r: InboxRow): LifecycleStage {
    if (isRejected(r)) return "rejected";
    if (isClosed(r) && isResolved(r)) return "closed-resolved";
    if (isClosed(r)) return "closed";
    if (isResolved(r)) return "resolved";
    // An agent proposed resolution but the reporter hasn't approved it
    // yet. Visually distinct from final-resolved so the reporter sees
    // there's a pending decision (#B.120).
    if (r.pending_resolution) return "pending-resolved";
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
    if (r.pending_comment_count > 0) return "comments";
    return null;
}
