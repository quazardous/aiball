/**
 * Frontend mirror of `src/decisions.ts` (#B.129).
 *
 * String-pure helpers to read the `meta.decision` sidecar attached to
 * a `comment_added`. The backend owns writes; the frontend only needs
 * to recognise:
 *   - is this comment decisional? (kind set)
 *   - what's its status? (pending / accepted / rejected)
 *   - is it the active one in the thread? (latest decision wins; active
 *     only while that latest one is still pending)
 */

import type { Message } from "./api";

export type DecisionKind = "plan" | "resolution";
export type DecisionStatus = "pending" | "accepted" | "rejected";

export interface CommentDecision {
    kind: DecisionKind;
    status: DecisionStatus;
    decided_by?: string;
    decided_at?: string;
}

/** Extract the decision block from a message's `meta` JSON. Returns
 *  null when meta is empty, malformed, or has no decision key. */
export function readDecision(m: Message): CommentDecision | null {
    if (!m.meta) return null;
    try {
        const parsed = JSON.parse(m.meta) as { decision?: CommentDecision };
        const d = parsed.decision;
        if (!d || !d.kind || !d.status) return null;
        return d;
    } catch {
        return null;
    }
}

/** Return the active decision comment in a thread = the LATEST approved
 *  decision-on-comment, but ONLY when that latest one is still pending.
 *  Null when the thread has no decision, or its newest decision is
 *  already accepted/rejected.
 *
 *  Latest-decision-wins, the frontend mirror of the backend
 *  `decisionGateByTicket()` (#273). Picking the latest decision REGARDLESS
 *  of status first (then gating on pending) is what makes a superseded
 *  older proposal stop resurfacing: once the newest plan/resolution is
 *  decided, an earlier still-pending one must NOT keep the composer's
 *  accept/reject buttons up. Previously this filtered to pending BEFORE
 *  taking the max id, so accepting a newer plan fell back to a stale older
 *  pending decision and the composer never cleared (david #zmbyks: "ticket
 *  accepté mais bouton inchangé" — two pending plans on the same ticket,
 *  the latest accepted, the buttons stuck on the older one). */
export function findActiveDecision(comments: Message[]): {
    message: Message;
    decision: CommentDecision;
} | null {
    let latest: { message: Message; decision: CommentDecision } | null = null;
    for (const m of comments) {
        if (m.kind !== "comment_added") continue;
        if (m.status !== "approved") continue;
        const d = readDecision(m);
        if (!d) continue;
        if (!latest || m.id > latest.message.id) {
            latest = { message: m, decision: d };
        }
    }
    if (!latest) return null;
    return latest.decision.status === "pending" ? latest : null;
}
