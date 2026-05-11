/**
 * Ticket-level state mutators that don't belong to the message lifecycle —
 * specifically broadcast (#B.72) and snooze / postpone (#B.329). These
 * fields live on the `tickets` row directly (not as separate events) so
 * the writes are simple updates.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, eq, isNotNull, lte } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

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
