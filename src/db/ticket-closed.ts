/**
 * #2339 — which of these tickets are closed, in one read.
 *
 * There is NO `closed` column (#2112): closure is a lifecycle EVENT, and a
 * ticket can be closed and reopened any number of times, so the latest of
 * `ticket_closed` / `ticket_reopened` wins. Approved events only: a close still
 * awaiting moderation has not happened.
 *
 * One rule for every reader. The pending counter and the pending list each
 * folded it on their own, and only one of them did, which is how poll counted
 * 19 pending tickets and listed 29.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

export function closedTicketIds(ticketIds: readonly number[]): Set<number> {
    const closed = new Set<number>();
    if (ticketIds.length === 0) return closed;
    const lifecycle = getDb()
        .select({ id: schema.messages.id, ticketId: schema.messages.ticketId, kind: schema.messages.kind })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.ticketId, [...ticketIds]),
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const lastClose = new Map<number, number>();
    const lastReopen = new Map<number, number>();
    for (const ev of lifecycle) {
        if (ev.ticketId == null) continue;
        const latest = ev.kind === "ticket_closed" ? lastClose : lastReopen;
        if (ev.id > (latest.get(ev.ticketId) ?? 0)) latest.set(ev.ticketId, ev.id);
    }
    for (const [ticketId, closeId] of lastClose) {
        if (closeId > (lastReopen.get(ticketId) ?? 0)) closed.add(ticketId);
    }
    return closed;
}
