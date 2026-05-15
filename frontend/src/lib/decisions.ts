/**
 * Frontend mirror of `src/decisions.ts` (#B.129).
 *
 * String-pure helpers to read the `meta.decision` sidecar attached to
 * a `comment_added`. The backend owns writes; the frontend only needs
 * to recognise:
 *   - is this comment decisional? (kind set)
 *   - what's its status? (pending / accepted / rejected)
 *   - is it the active one in the thread? (most recent pending wins)
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

/** Return the active decision comment in a thread = the most recent
 *  approved comment_added carrying a pending decision. Null when none. */
export function findActiveDecision(comments: Message[]): {
    message: Message;
    decision: CommentDecision;
} | null {
    let best: { message: Message; decision: CommentDecision } | null = null;
    for (const m of comments) {
        if (m.kind !== "comment_added") continue;
        if (m.status !== "approved") continue;
        const d = readDecision(m);
        if (!d || d.status !== "pending") continue;
        if (!best || m.id > best.message.id) {
            best = { message: m, decision: d };
        }
    }
    return best;
}
