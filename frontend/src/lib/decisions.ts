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

import type { Message, TicketSummary } from "./api";

// #803 — `findActiveDecision` accepts both Message (comments) and
// TicketSummary (the ticket itself, when ticket_new({then:"plan"}) attached
// a decision to its meta). Both shapes carry the fields we need (id +
// status + meta). The accept/reject call sites only use `.id`, so we cast
// the TicketSummary to Message at the seed site rather than fragmenting
// the consumer typing.
type DecisionBearing = Pick<Message, "id" | "status" | "meta">;

// Single source: the daemon's `src/decisions.ts` (via the `@shared` alias).
// Imported for local use in the helpers below AND re-exported so existing
// consumers keep importing them from here. The frontend keeps only its own
// message-shaped read helpers; the kind/status taxonomy is shared.
import type { DecisionKind, DecisionStatus, CommentDecision } from "@shared/decisions";
export type { DecisionKind, DecisionStatus, CommentDecision };

/** Extract the decision block from a message's `meta` JSON. Returns
 *  null when meta is empty, malformed, or has no decision key. */
export function readDecision(m: DecisionBearing): CommentDecision | null {
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
/** #3006 — the thread's LATEST decision, whatever its status: the one the
 *  gate reads. A pending decision on any other comment is superseded by it. */
function latestDecisionEntry(
    ticket: TicketSummary | null,
    comments: Message[],
): { message: Message; decision: CommentDecision } | null {
    let latest: { message: Message; decision: CommentDecision } | null = null;
    // #803 — `ticket_new({then:"plan"})` attaches a decision DIRECTLY on
    // the ticket_created event itself ; the UI must surface it like a
    // decision-bearing comment. Seed `latest` from the ticket's meta so a
    // later approved comment with a fresher decision still wins (latest-id).
    // The consumer (decide/reject handlers) only reads `.id` so the cast
    // is safe ; the ticket id and ticket_created.id are the SAME number.
    if (ticket && ticket.status === "approved") {
        const d = readDecision(ticket);
        if (d) latest = { message: ticket as unknown as Message, decision: d };
    }
    for (const m of comments) {
        if (m.kind !== "comment_added") continue;
        if (m.status !== "approved") continue;
        const d = readDecision(m);
        if (!d) continue;
        if (!latest || m.id > latest.message.id) {
            latest = { message: m, decision: d };
        }
    }
    return latest;
}

/** #3006 — the thread's latest decision (any status), named for a tooltip. */
export interface DecisionRef { id: number; kind: DecisionKind; hashid: string | null }
export function latestDecisionRef(ticket: TicketSummary | null, comments: Message[]): DecisionRef | null {
    const latest = latestDecisionEntry(ticket, comments);
    return latest ? { id: latest.message.id, kind: latest.decision.kind, hashid: latest.message.hashid ?? null } : null;
}

/** #3006 — what supersedes `m`'s decision: set only when `m` carries a
 *  decision still pending and a newer decision is the thread's latest. */
export function supersedingDecision(m: DecisionBearing, latest: DecisionRef | null): DecisionRef | null {
    const d = readDecision(m);
    if (!d || d.status !== "pending" || !latest || latest.id === m.id) return null;
    return latest;
}

export function findActiveDecision(
    ticket: TicketSummary | null,
    comments: Message[],
): {
    message: Message;
    decision: CommentDecision;
} | null {
    const latest = latestDecisionEntry(ticket, comments);
    if (!latest) return null;
    return latest.decision.status === "pending" ? latest : null;
}
