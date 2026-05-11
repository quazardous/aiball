/**
 * Ticket-level state mutators that don't belong to the message lifecycle —
 * specifically broadcast (#B.72) and snooze / postpone (#B.329). These
 * fields live on the `tickets` row directly (not as separate events) so
 * the writes are simple updates.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

// =====================================================================
//  Sub-tickets (per #B.62 follow-up)
// =====================================================================

/**
 * Lightweight summary of a sub-ticket, used by the thread API to render
 * a recap of children in the parent's header. Excludes rejected
 * children so they don't pollute the parent's view.
 */
export interface SubTicketSummary {
    id: number;
    title: string;
    status: "pending" | "approved" | "rejected";
    closed: boolean;
}

/**
 * List direct children of a ticket (rows with parent_ticket_id = parentId),
 * with their lifecycle-derived `closed` flag. Rejected children are
 * filtered out. Ordered by id ASC (chronological).
 */
export function listSubTickets(parentId: number): SubTicketSummary[] {
    const db = getDb();
    const rows = db.select({
        id: schema.tickets.id,
        title: schema.tickets.title,
        editedTitle: schema.tickets.editedTitle,
        status: schema.tickets.status,
    })
        .from(schema.tickets)
        .where(eq(schema.tickets.parentTicketId, parentId))
        .orderBy(asc(schema.tickets.id))
        .all();
    if (rows.length === 0) return [];
    // Lifecycle replay across closed/reopened events to compute the
    // `closed` flag for each child. Same pattern as the inbox handler.
    const events = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(eq(schema.messages.status, "approved"))
        .orderBy(asc(schema.messages.id))
        .all();
    const ids = new Set(rows.map((r) => r.id));
    const closedById = new Map<number, boolean>();
    for (const ev of events) {
        if (!ids.has(ev.ticket_id)) continue;
        if (ev.kind === "ticket_closed") closedById.set(ev.ticket_id, true);
        else if (ev.kind === "ticket_reopened") closedById.set(ev.ticket_id, false);
    }
    return rows
        .filter((r) => r.status !== "rejected")
        .map((r) => ({
            id: r.id,
            title: r.editedTitle ?? r.title ?? "(no title)",
            status: r.status as "pending" | "approved" | "rejected",
            closed: closedById.get(r.id) ?? false,
        }));
}

// =====================================================================
//  Broadcast (#B.72)
// =====================================================================

/**
 * Read the broadcast flag of a ticket. Returns false for missing rows,
 * tolerates the column being absent on very old DBs that haven't run the
 * 0002 migration yet (though such DBs shouldn't exist in practice — the
 * migrator runs at boot).
 */
export function isTicketBroadcast(ticketId: number): boolean {
    const row = getDb().select({ broadcast: schema.tickets.broadcast })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    return row ? row.broadcast === 1 : false;
}

/**
 * Update the broadcast flag of a ticket. Returns true if the row exists.
 */
export function setTicketBroadcast(ticketId: number, value: boolean): boolean {
    const res = getDb().update(schema.tickets)
        .set({ broadcast: value ? 1 : 0 })
        .where(eq(schema.tickets.id, ticketId))
        .run();
    return res.changes > 0;
}

// =====================================================================
//  Postpone / snooze (#B.329)
// =====================================================================

/**
 * Snooze a ticket until the given ISO8601 timestamp. While the ticket is
 * snoozed, it's hidden from the open inbox (treated as closed for
 * filtering). The daemon's reveal cron clears the field at the deadline
 * and broadcasts a `message_edited` so the ticket bounces back into the
 * inbox.
 */
export function setTicketPostpone(ticketId: number, until: string | null): boolean {
    const res = getDb().update(schema.tickets)
        .set({ postponedUntil: until })
        .where(eq(schema.tickets.id, ticketId))
        .run();
    return res.changes > 0;
}

export function getTicketPostpone(ticketId: number): string | null {
    const row = getDb()
        .select({ p: schema.tickets.postponedUntil })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    return row?.p ?? null;
}

/**
 * Return the ids of tickets whose snooze period has expired (i.e.
 * `postponed_until <= now`). The caller (daemon cron) is expected to
 * clear the field for each. Cheap query — uses the
 * `idx_tickets_postponed` index.
 */
export function listExpiredPostpones(nowIsoString: string = nowIso()): number[] {
    const rows = getDb()
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(and(
            isNotNull(schema.tickets.postponedUntil),
            lte(schema.tickets.postponedUntil, nowIsoString),
        ))
        .all();
    return rows.map((r) => r.id);
}
