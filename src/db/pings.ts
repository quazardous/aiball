/**
 * Pings — the per-recipient delivery table that powers the personal
 * inbox. Combines:
 *   - `insertPing` / `deletePingsForMessage` (fan-out from
 *     `messages.fanOutPings`).
 *   - `listUnread` / `unreadCount` / `listPings` / `markPingsRead` /
 *     `unreadPingCount` (read-side helpers for the inbox + MCP
 *     `_status` micro-probe).
 *   - `markMessageSeen` / `markAllSeenForProject` / `markTicketSeen` /
 *     `markTicketUnseen` / `markSeenUpToForProject` (write-side, per
 *     scope: single message, ticket thread, whole project).
 *   - `ticketUnreadFlags` (batched per-ticket flag for /api/inbox).
 *   - `pendingTicketsByAuthor` (count for `_status.my_pending`).
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import {
    getDb,
    nowIso,
    ticketRowToMessage,
    messageRowToMessage,
    type Message,
} from "./connection.js";

// =====================================================================
//  Write side
// =====================================================================

export function insertPing(recipient: string, messageId: number): void {
    getDb().insert(schema.pings).values({
        recipient,
        messageId,
        createdAt: nowIso(),
    }).onConflictDoNothing().run();
}

/**
 * Wipe every ping row that points at this message id. Used when a message
 * is rejected: the at-insertion fan-out had already pinged subscribers,
 * but the message will never be approved so it should not keep surfacing
 * as unread in their inboxes. Called from the moderation handler in
 * api.ts as soon as the rejection lands.
 */
export function deletePingsForMessage(messageId: number): { deleted: number } {
    const r = getDb().delete(schema.pings)
        .where(eq(schema.pings.messageId, messageId))
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
            eq(schema.pings.messageId, message_id),
            isNull(schema.pings.seenAt),
        )).run();
    return { updated: r.changes };
}

export function markAllSeenForProject(
    consumer_id: string,
    project: string,
): { updated: number } {
    const db = getDb();
    // Collect ids in the project (tickets + messages), then mark pings.
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
            inArray(schema.pings.messageId, allIds),
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
    const messageIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id);
    const allIds = [ticket_id, ...messageIds];
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            inArray(schema.pings.messageId, allIds),
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
    const messageIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id);
    const allIds = [ticket_id, ...messageIds];
    const r = db.update(schema.pings)
        .set({ seenAt: null })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNotNull(schema.pings.seenAt),
            inArray(schema.pings.messageId, allIds),
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
            inArray(schema.pings.messageId, allIds),
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
    if (opts.upToId) conds.push(lte(schema.pings.messageId, opts.upToId));
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
    // A ping's message_id may live in either tickets or _messages. Two
    // queries, merged in JS, ordered by id ASC so paginated mark_read
    // advances monotonically.
    const ticketHits = db.select({ t: schema.tickets, ping: schema.pings })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
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

    const messageHits = db.select({ m: schema.messages, project: schema.tickets.project })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
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
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
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
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
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
    // Pings on the ticket roots themselves.
    const rootHits = db.select({
        ticket_id: schema.pings.messageId,
    }).from(schema.pings).where(and(
        eq(schema.pings.recipient, consumer_id),
        isNull(schema.pings.seenAt),
        inArray(schema.pings.messageId, ticket_ids),
    )).all();
    for (const r of rootHits) out.set(r.ticket_id, true);
    // Pings on comments → join _messages to map back to ticket_id.
    const commentHits = db.select({
        ticket_id: schema.messages.ticketId,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.pings.messageId, schema.messages.id))
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

    // Filter self-pings out: a ping where the underlying message was authored
    // by the recipient itself is not interesting (transition pings on the
    // agent's own posts pollute the inbox). Each query gets the by_agent
    // column from the appropriate table (tickets vs _messages).
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
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
        .where(and(...ticketConds))
        .all();

    const messageHits = db.select({
        ping: schema.pings,
        m: schema.messages,
        project: schema.tickets.project,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(...messageConds))
        .all();

    const out: Ping[] = [
        ...ticketHits.map((r) => ({
            recipient: r.ping.recipient,
            message_id: r.ping.messageId,
            created_at: r.ping.createdAt,
            seen_at: r.ping.seenAt,
            message: ticketRowToMessage(r.t),
        })),
        ...messageHits.map((r) => ({
            recipient: r.ping.recipient,
            message_id: r.ping.messageId,
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
    // Self-pings filtered: split count over tickets + messages joins.
    const t = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
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
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
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
