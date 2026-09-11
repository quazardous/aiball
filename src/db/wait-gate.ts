/**
 * #2297 — `then: wait` + `wait_for`: a pending wait on another ticket.
 *
 * A wait is a decision like the others (the latest decision on a ticket wins),
 * with one extra: the ticket it names. While it is the ticket's latest decision
 * and still pending, it gates the ticket like a soft `depends_on` on that
 * target: blocked while the target is open, with no relation written. When the
 * target closes, the wait is accepted and the ticket's watchers are woken; a
 * human lifts it earlier by rejecting it.
 */
import { and, asc, eq, inArray, like } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { decisionGesture } from "../ticket-transitions.js";

interface LatestDecision {
    messageId: number;
    kind: string;
    status: string;
    waitFor: number | null;
}

/** The latest decision carried by a comment on each ticket. */
function latestCommentDecisions(ticketIds?: readonly number[]): Map<number, LatestDecision> {
    const rows = getDb().select({
        id: schema.messages.id,
        ticketId: schema.messages.ticketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
            like(schema.messages.meta, "%\"decision\"%"),
            ticketIds ? inArray(schema.messages.ticketId, [...ticketIds]) : undefined,
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    const latest = new Map<number, LatestDecision>();
    for (const r of rows) {
        if (r.ticketId == null || !r.meta) continue;
        let d: { kind?: unknown; status?: unknown; wait_for?: unknown } | undefined;
        try {
            d = (JSON.parse(r.meta) as { decision?: typeof d }).decision;
        } catch { continue; }
        if (!d || typeof d.kind !== "string" || typeof d.status !== "string") continue;
        latest.set(r.ticketId, {
            messageId: r.id,
            kind: d.kind,
            status: d.status,
            waitFor: Number.isInteger(d.wait_for) ? d.wait_for as number : null,
        });
    }
    return latest;
}

function pendingWait(d: LatestDecision): boolean {
    return d.status === "pending" && d.waitFor !== null && decisionGesture(d.kind)?.waitsForTicket === true;
}

/** Ticket → the ticket its pending wait names, for the tickets whose latest decision is one. */
export function pendingWaitTargets(ticketIds?: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (ticketIds && ticketIds.length === 0) return out;
    for (const [ticketId, d] of latestCommentDecisions(ticketIds)) {
        if (pendingWait(d)) out.set(ticketId, d.waitFor!);
    }
    return out;
}

/** The pending waits naming `targetId`: the ticket and the comment carrying each one. */
export function ticketsWaitingOn(targetId: number): { ticketId: number; messageId: number }[] {
    const out: { ticketId: number; messageId: number }[] = [];
    for (const [ticketId, d] of latestCommentDecisions()) {
        if (pendingWait(d) && d.waitFor === targetId) out.push({ ticketId, messageId: d.messageId });
    }
    return out;
}
