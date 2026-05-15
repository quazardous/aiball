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
    nextTicketId,
    nextMessageId,
    pickFreshHashid,
    ticketRowToMessage,
    messageRowToMessage,
    type Intent,
    type Message,
    type MessageKind,
    type MessageStatus,
    type NewMessage,
} from "./connection.js";
import {
    injectMarkers,
    parseMeta,
    serializeMeta,
    setQuestionStatus,
    type MessageMeta,
    type QuestionAnswer,
} from "../questions.js";
import { applyDecision, type DecisionStatus } from "../decisions.js";

export function insertMessage(m: NewMessage): Message {
    const db = getDb();
    return db.transaction((tx) => {
        const createdAt = nowIso();
        // #B.104: stamp stable `<!-- q:xxx -->` markers on every
        // `- [ ]` line so future toggles can address the question by
        // id regardless of edits / reorders. Idempotent — lines that
        // already carry a marker are left alone.
        const bodyWithMarkers = injectMarkers(m.body ?? null);
        if (m.kind === "ticket_created") {
            const id = nextTicketId(tx);
            const seq = (tx.select({
                n: sql<number>`COALESCE(MAX(${schema.tickets.displaySeq}), 0) + 1`,
            }).from(schema.tickets).where(eq(schema.tickets.project, m.project)).get())?.n ?? 1;
            // For ticket_created, NewMessage.parent_id (when set) is the
            // parent TICKET id (sub-ticket lineage, per #B.61 follow-up).
            // For non-ticket kinds, parent_id is the parent message id.
            const inserted = tx.insert(schema.tickets).values({
                id,
                project: m.project,
                displaySeq: seq,
                title: m.title ?? "",
                body: bodyWithMarkers || null,
                summary: m.summary ?? null,
                byAgent: m.by_agent ?? null,
                intent: m.intent ?? null,
                createdAt,
                parentTicketId: m.parent_id ?? null,
            }).returning().get();
            return ticketRowToMessage(inserted);
        }
        if (!m.ticket_id) {
            throw new Error(`${m.kind} requires ticket_id`);
        }
        const id = nextMessageId(tx);
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
        // #B.129: if the author tagged this comment as decisional at
        // post time, stamp `meta.decision = {kind, status:"pending"}`.
        // Only honored on comment_added (validator enforces that).
        let metaInit: string | null = null;
        if (m.decision_kind && m.kind === "comment_added") {
            metaInit = JSON.stringify({
                decision: { kind: m.decision_kind, status: "pending" },
            });
        }
        const inserted = tx.insert(schema.messages).values({
            id,
            ticketId: m.ticket_id,
            displaySeq: seq,
            kind: m.kind,
            parentMessageId,
            body: bodyWithMarkers || null,
            byAgent: m.by_agent ?? null,
            createdAt,
            hashid,
            meta: metaInit,
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
        summary?: string | null;
        intent?: Intent | null;
    },
): Message | null {
    const db = getDb();
    // #B.104: re-inject `<!-- q:xxx -->` markers on any new task-list
    // lines the editor added. Existing markers are preserved.
    const editedBody =
        fields.body !== undefined && fields.body !== null
            ? injectMarkers(fields.body)
            : fields.body;
    // Try tickets first — only tickets have edited_title and intent.
    const ticketPatch: Partial<schema.NewTicket> = {};
    if (fields.title !== undefined) ticketPatch.editedTitle = fields.title;
    if (fields.body !== undefined) ticketPatch.editedBody = editedBody;
    // Summary has no `edited_summary` overlay — it's agent-authored
    // metadata, mutated in place (#B.87). The owner-bypass check that
    // gates this edit is the same gate that protects title/body anyway.
    if (fields.summary !== undefined) ticketPatch.summary = fields.summary;
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
            .set({ editedBody: editedBody })
            .where(eq(schema.messages.id, id))
            .run();
    }
    return getMessage(id);
}

/**
 * Insert a relation-event pseudo-comment (`ticket_sub_added` or
 * `ticket_referenced`) on the target thread. These rows are not user
 * input — the daemon auto-emits them when:
 *   - a sub-ticket is created with parent_id set (kind=ticket_sub_added)
 *   - a body mentions another ticket via `#B.NN` (kind=ticket_referenced)
 *
 * Always inserted as `approved` with `decided_by=auto` since they
 * shouldn't go through moderation (they're informational lifecycle
 * events, not user-authored content).
 *
 * Returns the new pseudo-comment as a Message (so the caller can fan
 * out pings + WS broadcast through the normal channels).
 */
export function insertRelationEvent(opts: {
    target_ticket_id: number;
    source_ticket_id: number;
    kind: "ticket_sub_added" | "ticket_referenced";
    by_agent: string | null;
}): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const id = nextMessageId(tx);
        const seq = (tx.select({
            n: sql<number>`COALESCE(MAX(${schema.messages.displaySeq}), 0) + 1`,
        }).from(schema.messages).where(eq(schema.messages.ticketId, opts.target_ticket_id)).get())?.n ?? 1;
        const createdAt = nowIso();
        const hashid = pickFreshHashid(tx);
        const inserted = tx.insert(schema.messages).values({
            id,
            ticketId: opts.target_ticket_id,
            displaySeq: seq,
            kind: opts.kind,
            body: "",
            byAgent: opts.by_agent ?? null,
            status: "approved",
            decidedAt: createdAt,
            decidedBy: "auto",
            createdAt,
            hashid,
            sourceTicketId: opts.source_ticket_id,
        }).returning().get();
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, opts.target_ticket_id)).get();
        return messageRowToMessage(inserted, parent?.project ?? "");
    });
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

// =====================================================================
// Question / metadata side-channel (#B.104)
// =====================================================================

/**
 * Mark a question (identified by its `q-xxx` id) as answered: flips
 * `[ ]` → `[x]` in the parent's body AND records the audit in
 * `meta.questions[qid]`. Idempotent — already-answered questions
 * return the existing message untouched.
 *
 * Walks ticket-first, then comments. Returns the updated Message,
 * or null when the parent doesn't exist / the question id isn't
 * found in the body.
 */
export function markQuestionAnswered(
    messageId: number,
    questionId: string,
    answer: QuestionAnswer,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        // Try the tickets table first.
        const t = tx.select().from(schema.tickets).where(eq(schema.tickets.id, messageId)).get();
        if (t) {
            const r = setQuestionStatus(t.body, questionId, "answered");
            if (!r.changed) {
                // No body change means either the question was already
                // answered or the id isn't in the body. In the first
                // case we still want to record the audit if missing.
                const meta = parseMeta(t.meta ?? null);
                const already = meta.questions?.[questionId];
                if (already) return ticketRowToMessage(t);
            }
            const meta = mergeMeta(t.meta ?? null, questionId, answer);
            tx.update(schema.tickets)
                .set({ body: r.body, meta: serializeMeta(meta) })
                .where(eq(schema.tickets.id, messageId))
                .run();
            const fresh = tx.select().from(schema.tickets).where(eq(schema.tickets.id, messageId)).get();
            return fresh ? ticketRowToMessage(fresh) : null;
        }
        // Fall through to comments.
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        const r = setQuestionStatus(m.body, questionId, "answered");
        const meta = mergeMeta(m.meta ?? null, questionId, answer);
        tx.update(schema.messages)
            .set({ body: r.body, meta: serializeMeta(meta) })
            .where(eq(schema.messages.id, messageId))
            .run();
        const fresh = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!fresh) return null;
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, fresh.ticketId)).get();
        return messageRowToMessage(fresh, parent?.project ?? "");
    });
}

function mergeMeta(
    raw: string | null,
    questionId: string,
    answer: QuestionAnswer,
): MessageMeta {
    const meta = parseMeta(raw);
    meta.questions = { ...(meta.questions ?? {}), [questionId]: answer };
    return meta;
}

/**
 * Apply an accept/reject to the `meta.decision` sidecar of a comment
 * (#B.129). Comments only — tickets carry their own lifecycle via
 * ticket_resolved / ticket_blocked. Returns the updated message or null
 * when the message id doesn't exist OR has no decision to update.
 *
 * Throws for invalid transitions (re-deciding a terminal decision).
 * The HTTP layer maps the throw to 409 Conflict.
 */
export function applyMessageDecision(
    messageId: number,
    status: DecisionStatus,
    decidedBy: string,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        const meta = parseMeta(m.meta ?? null);
        const r = applyDecision(meta.decision, status, decidedBy, new Date().toISOString());
        if (!r.changed) {
            // idempotent re-decide — return current row unchanged
            const parent = tx.select({ project: schema.tickets.project })
                .from(schema.tickets).where(eq(schema.tickets.id, m.ticketId)).get();
            return messageRowToMessage(m, parent?.project ?? "");
        }
        meta.decision = r.decision;
        tx.update(schema.messages)
            .set({ meta: serializeMeta(meta) })
            .where(eq(schema.messages.id, messageId))
            .run();
        const fresh = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!fresh) return null;
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, fresh.ticketId)).get();
        return messageRowToMessage(fresh, parent?.project ?? "");
    });
}
