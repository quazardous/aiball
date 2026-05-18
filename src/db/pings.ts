/**
 * Pings — the per-recipient delivery table. After migration 0007 the
 * polymorphic `pings.message_id` was split into two mutually exclusive
 * columns:
 *   - `pings.ticket_id`  → set when the ping points at a ticket root.
 *   - `pings.comment_id` → set when the ping points at a comment / lifecycle.
 *
 * Exactly one is non-NULL per row (CHECK enforced).
 *
 * Because the migration ALSO ensured that `tickets.id` and `_messages.id`
 * never overlap (messages are shifted by +1_000_000), callers can keep
 * passing a plain integer `id` to most read/seen helpers — the helpers
 * test both columns with OR; at most one matches.
 *
 * For inserts the caller must say which kind it is (we wrap that in
 * `insertPing(recipient, msg)` where msg.kind decides the column).
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { emitPing } from "../event-bus.js";
import {
    getDb,
    nowIso,
    ticketRowToMessage,
    messageRowToMessage,
    type Message,
    type MessageKind,
} from "./connection.js";

// =====================================================================
//  Helpers
// =====================================================================

/**
 * Returns a `WHERE pings.<col> = id` clause that matches whichever of the
 * two target columns the id belongs to. Convenient for the seen / delete
 * helpers that take a plain integer (the caller has lost the kind by then).
 */
function targetMatches(id: number) {
    return or(eq(schema.pings.ticketId, id), eq(schema.pings.commentId, id));
}

function targetInArray(ids: number[]) {
    return or(
        inArray(schema.pings.ticketId, ids),
        inArray(schema.pings.commentId, ids),
    );
}

// =====================================================================
//  Write side
// =====================================================================

/**
 * Insert a ping. The caller passes the Message itself (or just enough of
 * one) so we can route the row to the right column based on `kind`.
 *
 * The shape `{ id, kind }` is loose on purpose — most callers have a full
 * `Message` in hand from the fan-out path, but the moderation transition
 * ping in api.ts only needs id + kind.
 */
export function insertPing(
    recipient: string,
    msg: { id: number; kind: MessageKind },
): void {
    const isTicket = msg.kind === "ticket_created";
    const r = getDb().insert(schema.pings).values({
        recipient,
        ticketId: isTicket ? msg.id : null,
        commentId: isTicket ? null : msg.id,
        createdAt: nowIso(),
    }).onConflictDoNothing().run();
    // Only emit when the row was actually inserted (onConflictDoNothing
    // can swallow a duplicate). Subscribers (SSE) react in real-time —
    // no more polling-lag (#B.148 phase A).
    if (r.changes > 0) {
        emitPing(recipient, {
            ticket_id: isTicket ? msg.id : undefined,
            comment_id: isTicket ? undefined : msg.id,
        });
    }
}

/**
 * Wipe every ping row that points at this message id (whichever column).
 * Used when a message is rejected: the at-insertion fan-out had already
 * pinged subscribers, but the message will never be approved so it
 * should not keep surfacing as unread in their inboxes.
 */
export function deletePingsForMessage(messageId: number): { deleted: number } {
    const r = getDb().delete(schema.pings)
        .where(targetMatches(messageId))
        .run();
    return { deleted: r.changes };
}

export function markMessageSeen(
    consumer_id: string,
    message_id: number,
): { updated: number } {
    const r = getDb().update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            targetMatches(message_id),
            isNull(schema.pings.seenAt),
        )).run();
    return { updated: r.changes };
}

export function markAllSeenForProject(
    consumer_id: string,
    project: string,
): { updated: number } {
    const db = getDb();
    const ticketIds = db.select({ id: schema.tickets.id })
        .from(schema.tickets).where(eq(schema.tickets.project, project)).all().map((r) => r.id);
    const messageIds = ticketIds.length
        ? db.select({ id: schema.messages.id }).from(schema.messages)
            .where(inArray(schema.messages.ticketId, ticketIds)).all().map((r) => r.id)
        : [];
    const allIds = [...ticketIds, ...messageIds];
    if (!allIds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            targetInArray(allIds),
        )).run();
    return { updated: r.changes };
}

/**
 * Mark every ping the consumer has on this ticket (and on every comment of
 * the thread) as seen. Used by the UI auto-mark-read on the thread detail
 * view (per #B91) and by the explicit "mark read" toggle in the list row
 * (#C92). Idempotent — pings already seen are left alone.
 */
export function markTicketSeen(
    consumer_id: string,
    ticket_id: number,
): { updated: number } {
    const db = getDb();
    const commentIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id);
    // Build the WHERE — the ticket-root ping uses pings.ticket_id, the
    // comment pings use pings.comment_id. Two OR'd predicates.
    const conds = [eq(schema.pings.ticketId, ticket_id)];
    if (commentIds.length) conds.push(inArray(schema.pings.commentId, commentIds));
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            or(...conds),
        )).run();
    return { updated: r.changes };
}

/**
 * Like markTicketSeen but bounded by an upper message id. Only acks
 * pings whose target message id is <= upToId. Used by the auto-mark
 * path in ThreadView (#B.191): the dwell timer captures the max msg
 * id present at mount, then acks only THAT slice — comments arriving
 * after mount keep their ping unseen so the row stays bold+green in
 * the inbox even while the user is reading.
 */
export function markTicketSeenUpTo(
    consumer_id: string,
    ticket_id: number,
    upToId: number,
): { updated: number } {
    const db = getDb();
    const commentIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id)
        .filter((id) => id <= upToId);
    const conds = [];
    if (ticket_id <= upToId) conds.push(eq(schema.pings.ticketId, ticket_id));
    if (commentIds.length) conds.push(inArray(schema.pings.commentId, commentIds));
    if (!conds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            or(...conds),
        )).run();
    return { updated: r.changes };
}

/**
 * Inverse of markTicketSeen: clear the seen_at on every ping the consumer
 * has on this ticket and its comments. Used by the explicit "mark unread"
 * toggle in the list row (#C92) so the thread re-surfaces in unread filters.
 */
export function markTicketUnseen(
    consumer_id: string,
    ticket_id: number,
): { updated: number } {
    const db = getDb();
    const commentIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id);
    const conds = [eq(schema.pings.ticketId, ticket_id)];
    if (commentIds.length) conds.push(inArray(schema.pings.commentId, commentIds));
    const r = db.update(schema.pings)
        .set({ seenAt: null })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNotNull(schema.pings.seenAt),
            or(...conds),
        )).run();
    return { updated: r.changes };
}

export function markSeenUpToForProject(
    consumer_id: string,
    project: string,
    upToId: number,
): { updated: number } {
    const db = getDb();
    const ticketIds = db.select({ id: schema.tickets.id })
        .from(schema.tickets).where(eq(schema.tickets.project, project)).all().map((r) => r.id);
    const messageIds = ticketIds.length
        ? db.select({ id: schema.messages.id }).from(schema.messages)
            .where(inArray(schema.messages.ticketId, ticketIds)).all().map((r) => r.id)
        : [];
    const allIds = [...ticketIds, ...messageIds].filter((id) => id <= upToId);
    if (!allIds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            targetInArray(allIds),
        )).run();
    return { updated: r.changes };
}

export function markPingsRead(opts: {
    recipient: string;
    upToId?: number;
    all?: boolean;
}): { updated: number } {
    if (!opts.upToId && !opts.all) return { updated: 0 };
    const conds = [
        eq(schema.pings.recipient, opts.recipient),
        isNull(schema.pings.seenAt),
    ];
    if (opts.upToId) {
        // `upToId` is a cursor over the combined id space — match
        // whichever target column is set, gated by ≤ cursor.
        conds.push(
            or(
                and(isNotNull(schema.pings.ticketId), lte(schema.pings.ticketId, opts.upToId)),
                and(isNotNull(schema.pings.commentId), lte(schema.pings.commentId, opts.upToId)),
            )!,
        );
    }
    const r = getDb().update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(...conds))
        .run();
    return { updated: r.changes };
}

// =====================================================================
//  Read side
// =====================================================================

/**
 * Self-pings (where the underlying message's by_agent matches the ping's
 * recipient) are filtered out. They land in the table by way of transition
 * pings — when a moderator decides on a pending post, the daemon inserts a
 * ping for the author so the agent could in theory poll for "my own status
 * changed". But surfacing those in the same `unread()` feed as activity
 * pings clutters the inbox: the agent already knows what they posted. Data
 * is preserved in the table; just hidden from the user-facing query.
 */
export function listUnread(
    consumer_id: string,
    project: string,
    limit = 100,
): Message[] {
    const db = getDb();
    // Ticket-pings: join pings.ticket_id → tickets.id.
    const ticketHits = db.select({ t: schema.tickets, ping: schema.pings })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, project),
            or(
                isNull(schema.tickets.byAgent),
                ne(schema.tickets.byAgent, consumer_id),
            ),
        ))
        .all();

    // Comment-pings: join pings.comment_id → _messages.id, then tickets for project filter.
    const messageHits = db.select({ m: schema.messages, project: schema.tickets.project })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, project),
            or(
                isNull(schema.messages.byAgent),
                ne(schema.messages.byAgent, consumer_id),
            ),
        ))
        .all();

    const merged: Message[] = [
        ...ticketHits.map((r) => ticketRowToMessage(r.t)),
        ...messageHits.map((r) => messageRowToMessage(r.m, r.project)),
    ].sort((a, b) => a.id - b.id);

    return merged.slice(0, limit);
}

/**
 * Count the tickets posted by `by_agent` that are still pending
 * moderation. Cheap (single COUNT, indexed on by_agent + status). Used
 * by the MCP `_status` block so an author sees, in passing, whether
 * their submissions are still waiting on a moderator.
 */
export function pendingTicketsByAuthor(by_agent: string): number {
    const r = getDb()
        .select({ n: sql<number>`COUNT(*)` })
        .from(schema.tickets)
        .where(and(
            eq(schema.tickets.byAgent, by_agent),
            eq(schema.tickets.status, "pending"),
        ))
        .get();
    return Number(r?.n ?? 0);
}

export function unreadCount(consumer_id: string, project: string): number {
    const db = getDb();
    const t = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, project),
            or(
                isNull(schema.tickets.byAgent),
                ne(schema.tickets.byAgent, consumer_id),
            ),
        )).get();
    const m = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, project),
            or(
                isNull(schema.messages.byAgent),
                ne(schema.messages.byAgent, consumer_id),
            ),
        )).get();
    return Number(t?.n ?? 0) + Number(m?.n ?? 0);
}

/**
 * For each ticket in `ticket_ids`, returns whether the consumer has at
 * least one unseen ping anywhere on its thread (the ticket itself or any
 * of its comments). Used by /api/inbox to surface the per-row unread flag
 * in a single batched query.
 */
export function ticketUnreadFlags(
    consumer_id: string,
    ticket_ids: number[],
): Map<number, boolean> {
    const out = new Map<number, boolean>();
    for (const id of ticket_ids) out.set(id, false);
    if (ticket_ids.length === 0) return out;
    const db = getDb();
    // Pings on the ticket roots (pings.ticket_id).
    const rootHits = db.select({
        ticket_id: schema.pings.ticketId,
    }).from(schema.pings).where(and(
        eq(schema.pings.recipient, consumer_id),
        isNull(schema.pings.seenAt),
        inArray(schema.pings.ticketId, ticket_ids),
    )).all();
    for (const r of rootHits) if (r.ticket_id !== null) out.set(r.ticket_id, true);
    // Pings on comments → join _messages to map back to ticket_id.
    const commentHits = db.select({
        ticket_id: schema.messages.ticketId,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.pings.commentId, schema.messages.id))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            inArray(schema.messages.ticketId, ticket_ids),
        ))
        .all();
    for (const r of commentHits) out.set(r.ticket_id, true);
    return out;
}

export interface Ping {
    recipient: string;
    message_id: number;
    created_at: string;
    seen_at: string | null;
    message: Message;
}

export function listPings(opts: {
    recipient: string;
    unreadOnly?: boolean;
    limit?: number;
}): Ping[] {
    const db = getDb();
    const baseConds = [eq(schema.pings.recipient, opts.recipient)];
    if (opts.unreadOnly) baseConds.push(isNull(schema.pings.seenAt));

    const ticketConds = [
        ...baseConds,
        or(
            isNull(schema.tickets.byAgent),
            ne(schema.tickets.byAgent, opts.recipient),
        ),
    ];
    const messageConds = [
        ...baseConds,
        or(
            isNull(schema.messages.byAgent),
            ne(schema.messages.byAgent, opts.recipient),
        ),
    ];

    const ticketHits = db.select({ ping: schema.pings, t: schema.tickets })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(and(...ticketConds))
        .all();

    const messageHits = db.select({
        ping: schema.pings,
        m: schema.messages,
        project: schema.tickets.project,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(...messageConds))
        .all();

    const out: Ping[] = [
        ...ticketHits.map((r) => ({
            recipient: r.ping.recipient,
            message_id: r.ping.ticketId!,
            created_at: r.ping.createdAt,
            seen_at: r.ping.seenAt,
            message: ticketRowToMessage(r.t),
        })),
        ...messageHits.map((r) => ({
            recipient: r.ping.recipient,
            message_id: r.ping.commentId!,
            created_at: r.ping.createdAt,
            seen_at: r.ping.seenAt,
            message: messageRowToMessage(r.m, r.project),
        })),
    ];
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (opts.limit) return out.slice(0, opts.limit);
    return out;
}

export function unreadPingCount(recipient: string): number {
    const db = getDb();
    const t = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(and(
            eq(schema.pings.recipient, recipient),
            isNull(schema.pings.seenAt),
            or(
                isNull(schema.tickets.byAgent),
                ne(schema.tickets.byAgent, recipient),
            ),
        )).get();
    const m = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .where(and(
            eq(schema.pings.recipient, recipient),
            isNull(schema.pings.seenAt),
            or(
                isNull(schema.messages.byAgent),
                ne(schema.messages.byAgent, recipient),
            ),
        )).get();
    return Number(t?.n ?? 0) + Number(m?.n ?? 0);
}
