/**
 * Messages — the legacy union-shape API. Reads and writes route
 * internally to either `tickets` (ticket_created roots) or
 * `_messages` (comments + lifecycle events) but external callers
 * only see the flat `Message` shape from connection.ts.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import {
    getDb,
    nowIso,
    nextGlobalId,
    pickFreshHashid,
    ticketRowToMessage,
    messageRowToMessage,
    type Intent,
    type Message,
    type MessageKind,
    type MessageStatus,
    type NewMessage,
} from "./connection.js";

export function insertMessage(m: NewMessage): Message {
    const db = getDb();
    return db.transaction((tx) => {
        const id = nextGlobalId(tx);
        const createdAt = nowIso();
        if (m.kind === "ticket_created") {
            const seq = (tx.select({
                n: sql<number>`COALESCE(MAX(${schema.tickets.displaySeq}), 0) + 1`,
            }).from(schema.tickets).where(eq(schema.tickets.project, m.project)).get())?.n ?? 1;
            const inserted = tx.insert(schema.tickets).values({
                id,
                project: m.project,
                displaySeq: seq,
                title: m.title ?? "",
                body: m.body ?? null,
                byAgent: m.by_agent ?? null,
                intent: m.intent ?? null,
                createdAt,
            }).returning().get();
            return ticketRowToMessage(inserted);
        }
        if (!m.ticket_id) {
            throw new Error(`${m.kind} requires ticket_id`);
        }
        const seq = (tx.select({
            n: sql<number>`COALESCE(MAX(${schema.messages.displaySeq}), 0) + 1`,
        }).from(schema.messages).where(eq(schema.messages.ticketId, m.ticket_id)).get())?.n ?? 1;
        // Legacy callers pass parent_id == ticket_id for top-level replies;
        // collapse that to NULL so the schema invariant ("NULL parent → ticket
        // root") is upheld.
        const parentMessageId =
            m.parent_id !== undefined &&
            m.parent_id !== null &&
            m.parent_id !== m.ticket_id
                ? m.parent_id
                : null;
        const hashid = pickFreshHashid(tx);
        const inserted = tx.insert(schema.messages).values({
            id,
            ticketId: m.ticket_id,
            displaySeq: seq,
            kind: m.kind,
            parentMessageId,
            body: m.body ?? null,
            byAgent: m.by_agent ?? null,
            createdAt,
            hashid,
        }).returning().get();
        // Resolve project via parent ticket for the legacy shape.
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, m.ticket_id)).get();
        return messageRowToMessage(inserted, parent?.project ?? m.project);
    });
}

export function getMessage(id: number): Message | null {
    const db = getDb();
    const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get();
    if (t) return ticketRowToMessage(t);
    const m = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!m) return null;
    const parent = db.select({ project: schema.tickets.project })
        .from(schema.tickets).where(eq(schema.tickets.id, m.ticketId)).get();
    return messageRowToMessage(m, parent?.project ?? "");
}

/**
 * Resolve a comment by its public hashid (`#C<hashid>`). Returns null if no
 * row matches. Used by the API/router to honor `/c/<hashid>` and
 * `#C<hashid>` markdown refs without ever exposing the internal numeric id.
 */
export function getMessageByHashid(hashid: string): Message | null {
    const db = getDb();
    const m = db.select().from(schema.messages)
        .where(eq(schema.messages.hashid, hashid))
        .get();
    if (!m) return null;
    const parent = db.select({ project: schema.tickets.project })
        .from(schema.tickets).where(eq(schema.tickets.id, m.ticketId)).get();
    return messageRowToMessage(m, parent?.project ?? "");
}

export function listMessages(filters: {
    status?: MessageStatus;
    project?: string;
    kind?: MessageKind;
    by_agent?: string;
    limit?: number;
} = {}): Message[] {
    const db = getDb();
    const includeTickets = !filters.kind || filters.kind === "ticket_created";
    const includeMessages = !filters.kind || filters.kind !== "ticket_created";

    const out: Message[] = [];

    if (includeTickets) {
        const conds = [];
        if (filters.status) conds.push(eq(schema.tickets.status, filters.status));
        if (filters.project) conds.push(eq(schema.tickets.project, filters.project));
        if (filters.by_agent) conds.push(eq(schema.tickets.byAgent, filters.by_agent));
        let q = db.select().from(schema.tickets).$dynamic();
        if (conds.length) q = q.where(and(...conds));
        const rows = q.orderBy(desc(schema.tickets.id)).all();
        for (const r of rows) out.push(ticketRowToMessage(r));
    }

    if (includeMessages) {
        const conds = [];
        if (filters.status) conds.push(eq(schema.messages.status, filters.status));
        if (filters.kind && filters.kind !== "ticket_created")
            conds.push(eq(schema.messages.kind, filters.kind));
        if (filters.by_agent) conds.push(eq(schema.messages.byAgent, filters.by_agent));
        // Project filter requires joining with tickets.
        let q = db
            .select({
                m: schema.messages,
                project: schema.tickets.project,
            })
            .from(schema.messages)
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
            .$dynamic();
        if (filters.project)
            conds.push(eq(schema.tickets.project, filters.project));
        if (conds.length) q = q.where(and(...conds));
        const rows = q.orderBy(desc(schema.messages.id)).all();
        for (const r of rows) out.push(messageRowToMessage(r.m, r.project));
    }

    out.sort((a, b) => b.id - a.id);
    if (filters.limit) return out.slice(0, filters.limit);
    return out;
}

/**
 * List pending lifecycle events of one or more kinds on a given ticket.
 * Used by submitMessage to clean up stale lifecycle pendings when a
 * terminal event lands — e.g. a successful close should reject any
 * other pending close/reopen on the same thread (they're moot once the
 * ticket is in a final state).
 */
export function listPendingLifecycleForTicket(
    ticketId: number,
    kinds: ("ticket_closed" | "ticket_reopened" | "ticket_resolved")[],
    excludeId?: number,
): Message[] {
    const db = getDb();
    const filters = [
        eq(schema.messages.ticketId, ticketId),
        inArray(schema.messages.kind, kinds),
        eq(schema.messages.status, "pending"),
    ];
    if (excludeId !== undefined) {
        filters.push(ne(schema.messages.id, excludeId));
    }
    const rows = db.select().from(schema.messages)
        .where(and(...filters))
        .all();
    if (rows.length === 0) return [];
    const parent = db.select({ project: schema.tickets.project })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    const project = parent?.project ?? "";
    return rows.map((r) => messageRowToMessage(r, project));
}

/**
 * List pending lifecycle proposals (ticket_resolved) on a given ticket.
 * Used by submitMessage to auto-approve dangling proposals when the
 * reporter closes the ticket: closing implicitly accepts any open
 * "marked resolved" proposal, so they shouldn't keep showing up as
 * pending in inboxes or in the UI.
 */
export function listPendingResolvedForTicket(ticketId: number): Message[] {
    const db = getDb();
    const rows = db.select().from(schema.messages)
        .where(
            and(
                eq(schema.messages.ticketId, ticketId),
                eq(schema.messages.kind, "ticket_resolved"),
                eq(schema.messages.status, "pending"),
            ),
        )
        .all();
    if (rows.length === 0) return [];
    const parent = db.select({ project: schema.tickets.project })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    const project = parent?.project ?? "";
    return rows.map((r) => messageRowToMessage(r, project));
}

export function updateMessageStatus(
    id: number,
    status: MessageStatus,
    decidedBy: "human" | "auto" | "owner",
    matchedRuleId: number | null = null,
): Message | null {
    const db = getDb();
    const decidedAt = nowIso();
    const t = db.update(schema.tickets)
        .set({ status, decidedAt, decidedBy, matchedRuleId })
        .where(eq(schema.tickets.id, id))
        .run();
    if (t.changes > 0) return getMessage(id);
    db.update(schema.messages)
        .set({ status, decidedAt, decidedBy, matchedRuleId })
        .where(eq(schema.messages.id, id))
        .run();
    return getMessage(id);
}

export function editMessage(
    id: number,
    fields: {
        title?: string | null;
        body?: string | null;
        intent?: Intent | null;
    },
): Message | null {
    const db = getDb();
    // Try tickets first — only tickets have edited_title and intent.
    const ticketPatch: Partial<schema.NewTicket> = {};
    if (fields.title !== undefined) ticketPatch.editedTitle = fields.title;
    if (fields.body !== undefined) ticketPatch.editedBody = fields.body;
    if (fields.intent !== undefined) ticketPatch.intent = fields.intent;
    if (Object.keys(ticketPatch).length > 0) {
        const t = db.update(schema.tickets)
            .set(ticketPatch)
            .where(eq(schema.tickets.id, id))
            .run();
        if (t.changes > 0) return getMessage(id);
    }
    // Otherwise this is a non-ticket message — body only. intent is
    // ticket-scoped and silently ignored on comments/lifecycle.
    if (fields.body !== undefined) {
        db.update(schema.messages)
            .set({ editedBody: fields.body })
            .where(eq(schema.messages.id, id))
            .run();
    }
    return getMessage(id);
}

export function noteMessage(id: number, note: string | null): Message | null {
    const db = getDb();
    const t = db.update(schema.tickets)
        .set({ humanNote: note })
        .where(eq(schema.tickets.id, id))
        .run();
    if (t.changes > 0) return getMessage(id);
    db.update(schema.messages)
        .set({ humanNote: note })
        .where(eq(schema.messages.id, id))
        .run();
    return getMessage(id);
}
