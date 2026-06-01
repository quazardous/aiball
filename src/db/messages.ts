/**
 * Messages — the legacy union-shape API. Reads and writes route
 * internally to either `tickets` (ticket_created roots) or
 * `_messages` (comments + lifecycle events) but external callers
 * only see the flat `Message` shape from connection.ts.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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
    type Priority,
} from "./connection.js";
import {
    injectMarkers,
    parseMeta,
    serializeMeta,
    setQuestionStatus,
    type MessageMeta,
    type QuestionAnswer,
} from "../questions.js";
import { applyDecision, promoteToDecision, reclassifyDecision, type DecisionStatus } from "../decisions.js";
import { getConfig } from "./config-overrides.js"; // #449: config-driven default priority

/**
 * #374: record `actor` as the ticket's last actor at time `at`. Called from
 * every action chokepoint (comment/lifecycle append in `insertMessage`, plus
 * decision accept/reject in `applyMessageDecision`). No-op when there's no real
 * actor: a null author or the `auto` moderation marker doesn't move whose-court
 * (an auto-approved comment's actor is its author, passed by the caller).
 * Latest write wins — actions arrive in chronological order, so a plain
 * overwrite keeps `last_actor` monotonic. See docs/TICKET_LIFECYCLE.md §4.2.
 */
function bumpLastActor(
    tx: BaseSQLiteDatabase<"sync", any, typeof schema>,
    ticketId: number,
    actor: string | null,
    at: string,
): void {
    if (!actor || actor === "auto") return;
    tx.update(schema.tickets)
        .set({ lastActor: actor, lastActorAt: at })
        .where(eq(schema.tickets.id, ticketId))
        .run();
}

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
            // #449: default priority is now config-driven — tickets.default_priority
            // (global default + per-project override via the config manager),
            // falling back to 'normal'. First real consumer of the config schema.
            const defaultPriority =
                (getConfig("tickets.default_priority", m.project) as Priority | undefined) ?? "normal";
            const inserted = tx.insert(schema.tickets).values({
                id,
                project: m.project,
                displaySeq: seq,
                title: m.title ?? "",
                body: bodyWithMarkers || null,
                summary: m.summary ?? null,
                byAgent: m.by_agent ?? null,
                intent: m.intent ?? null,
                priority: m.priority ?? defaultPriority,
                createdAt,
                parentTicketId: m.parent_id ?? null,
                // #374: the creator is the first "last actor" on the ticket.
                lastActor: m.by_agent ?? null,
                lastActorAt: createdAt,
                // #B.245 tristate. Omit when caller didn't specify so
                // the column default ('default') applies.
                ...(m.scope ? { scope: m.scope } : {}),
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
        // #B.129 + #B.130: stamp meta from optional post-time inputs.
        // decision_kind → meta.decision (decision-on-comment, #B.129)
        // summary_until → meta.summary_until (rolling TLDR, #B.130).
        //                Conceptually summarizes the thread state up to
        //                AND including this comment — not just this
        //                comment's body in isolation.
        // Both gated on kind===comment_added by the validator.
        let metaInit: string | null = null;
        if (m.kind === "comment_added" && (m.decision_kind || m.summary_until)) {
            const meta: Record<string, unknown> = {};
            if (m.decision_kind) {
                meta.decision = { kind: m.decision_kind, status: "pending" };
            }
            if (m.summary_until) {
                meta.summary_until = m.summary_until;
            }
            metaInit = JSON.stringify(meta);
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
            // #B.245 tristate: composer-side `scope`. Lifecycle events
            // (close/reopen) inherit it too — a "quiet close" at
            // scope=internal is a valid use case. Omit when unset so
            // the column default ('default') applies.
            ...(m.scope ? { scope: m.scope } : {}),
        }).returning().get();
        // #374: every comment + lifecycle event (closed/reopened/resolved/
        // blocked) reaching this branch is an ACTION → the author is now the
        // ticket's last actor. (Relation/sub/referenced/move events take other
        // insert paths and are structural, not actions — see TICKET_LIFECYCLE.)
        bumpLastActor(tx, m.ticket_id, m.by_agent ?? null, createdAt);
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
        // #B.222: sort by urgency hint first (urgent > high > normal > low),
        // panic-intent kept separate as a secondary tiebreaker so a
        // `priority: low` panic ticket still surfaces above a calm
        // urgent one — david: panic = bouton rouge orthogonal au reste.
        // CASE expr because text-alpha sort would scramble the enum
        // (urgent / normal / low / high alphabetical).
        const priorityCase = sql`CASE ${schema.tickets.priority}
            WHEN 'urgent' THEN 4
            WHEN 'high'   THEN 3
            WHEN 'normal' THEN 2
            WHEN 'low'    THEN 1
            ELSE 0
        END`;
        const panicCase = sql`CASE WHEN ${schema.tickets.intent} = 'panic' THEN 1 ELSE 0 END`;
        const rows = q.orderBy(desc(panicCase), desc(priorityCase), desc(schema.tickets.id)).all();
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

/**
 * Update the moderation status of a ticket OR a non-ticket message
 * (comment_added / ticket_closed / ticket_resolved / …).
 *
 * #569 (workaround #568) — tickets and messages have **distinct id
 * counters** (`nextTicketId` / `nextMessageId`, cf. migration 0007), so
 * id=42 can refer to BOTH a ticket and a message simultaneously. The
 * previous "try tickets, then messages" probe could update the wrong
 * row when both existed at the same id (rare at high counters, common
 * at low ones — typical for tests and freshly bootstrapped DBs).
 *
 * The caller passes `kind` to disambiguate :
 *   - `"ticket_created"` → target the `tickets` table.
 *   - any other `MessageKind` (comment_added / ticket_closed / …) →
 *     target the `messages` table.
 *   - `undefined` / `null` → legacy fallback (ticket first then message
 *     probe). Same buggy behaviour as before on id collision — kept so
 *     unhinted callers don't regress, but every new caller should pass
 *     the kind it already has in hand.
 */
export function updateMessageStatus(
    id: number,
    status: MessageStatus,
    decidedBy: "human" | "auto" | "owner",
    matchedRuleId: number | null = null,
    kind?: MessageKind | "ticket_created" | null,
): Message | null {
    const db = getDb();
    const decidedAt = nowIso();
    if (kind === "ticket_created") {
        db.update(schema.tickets)
            .set({ status, decidedAt, decidedBy, matchedRuleId })
            .where(eq(schema.tickets.id, id))
            .run();
        const t = db.select().from(schema.tickets)
            .where(eq(schema.tickets.id, id))
            .get();
        return t ? ticketRowToMessage(t) : null;
    }
    if (kind) {
        // Any MessageKind that isn't "ticket_created" lives in `messages`.
        db.update(schema.messages)
            .set({ status, decidedAt, decidedBy, matchedRuleId })
            .where(eq(schema.messages.id, id))
            .run();
        const m = db.select().from(schema.messages)
            .where(eq(schema.messages.id, id))
            .get();
        if (!m) return null;
        const parent = db.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, m.ticketId)).get();
        return messageRowToMessage(m, parent?.project ?? "");
    }
    // Legacy unhinted probe — kept for back-compat. Still buggy on id
    // collisions ; new code should always pass `kind`.
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
        /** #B.222: urgency hint. Tickets only; ignored on comments. NULL
         *  resets to the schema default 'normal' (= no override). */
        priority?: Priority | null;
        /** #553 (david `3r3vjq`) : ticket-level fan-out scope (= default
         *  scope for new events on this ticket). Tickets only ; ignored
         *  on comments. NULL resets to schema default 'default'. */
        scope?: string | null;
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
    if (fields.priority !== undefined) {
        // NULL clears back to the schema default 'normal'. The CHECK
        // constraint at the SQL layer rejects bogus values; api.ts +
        // mcp validate up front so the column is never touched with
        // garbage from here.
        ticketPatch.priority = fields.priority ?? "normal";
    }
    if (fields.scope !== undefined) {
        // #553 — same pattern as priority : NULL clears to schema
        // default 'default'. api.ts validates the value upfront.
        ticketPatch.scope = fields.scope ?? "default";
    }
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
 * Soft-delete a comment (#309). Human-only (enforced at the HTTP layer).
 * Flips status → `rejected` (so the row is excluded everywhere that already
 * drops rejected — counts / gates / brief / MCP reads) AND stamps
 * `meta.deleted={by,at}`. The marker distinguishes a user-deletion from a
 * moderation reject so the UI thread can re-surface it as a tombstone (only
 * with `?include_deleted=1`); the thread builder strips the body before
 * shipping it, the original stays in the row for audit.
 *
 * Guard: only `comment_added` (lifecycle events aren't deletable). Comments
 * carrying a decision (plan/resolution, any status) ARE deletable — david
 * #xkjr7m: "lève la restriction sur les commentaires avec des états". The
 * row is soft-kept (status→rejected), so its `hashid` still resolves and
 * `#C<hashid>` refs don't orphan; a deleted accepted-resolution simply drops
 * out of the lifecycle replay (status≠approved), so the ticket reverts to
 * unresolved — expected. Returns the updated Message, or null when the id
 * isn't a `comment_added`.
 */
export function deleteComment(id: number, by: string): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
        if (!m || m.kind !== "comment_added") return null;
        const meta = parseMeta(m.meta ?? null);
        meta.deleted = { by, at: new Date().toISOString() };
        tx.update(schema.messages)
            .set({
                status: "rejected",
                decidedBy: "human",
                decidedAt: new Date().toISOString(),
                meta: serializeMeta(meta),
            })
            .where(eq(schema.messages.id, id))
            .run();
        const fresh = tx.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
        if (!fresh) return null;
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, fresh.ticketId)).get();
        return messageRowToMessage(fresh, parent?.project ?? "");
    });
}

/**
 * Move a whole ticket thread to another project (#294). The project lives
 * ONLY on the ticket head row (`tickets.project`); messages derive their
 * project by joining `ticket_id` → tickets, so the move is a single head
 * UPDATE: `project` + a fresh `display_seq` in the destination (the
 * UNIQUE(project, display_seq) constraint forbids reusing the source seq).
 * Comments, hashids and the per-ticket message numbering are untouched —
 * the whole thread follows the head.
 *
 * Records an in-thread audit as a system `comment_added` (auto-approved,
 * `meta.moved={from,to,by}`) so the timeline shows the move without needing
 * a brand-new lifecycle kind (and it renders through the existing comment
 * path everywhere). Returns `{ ticket, event }` — `event` is null when
 * `from === target` (no-op). Returns null when `ticketId` isn't a ticket.
 * Permission + fan-out/broadcast are the caller's job (see moveTicketTo).
 */
export function moveTicket(
    ticketId: number,
    targetProject: string,
    byAgent: string | null,
): { ticket: Message; event: Message | null; from: string } | null {
    const db = getDb();
    return db.transaction((tx) => {
        const t = tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
        if (!t) return null;
        const from = t.project;
        if (from === targetProject) {
            return { ticket: ticketRowToMessage(t), event: null, from };
        }
        // Fresh display_seq in the destination project (MAX+1), so the
        // moved ticket doesn't collide with an existing (project, seq).
        const seq = (tx.select({
            n: sql<number>`COALESCE(MAX(${schema.tickets.displaySeq}), 0) + 1`,
        }).from(schema.tickets).where(eq(schema.tickets.project, targetProject)).get())?.n ?? 1;
        const moved = tx.update(schema.tickets)
            .set({ project: targetProject, displaySeq: seq })
            .where(eq(schema.tickets.id, ticketId))
            .returning().get();
        // In-thread audit comment (system-authored, auto-approved). Derives
        // the NEW project via the head we just updated.
        const id = nextMessageId(tx);
        const mseq = (tx.select({
            n: sql<number>`COALESCE(MAX(${schema.messages.displaySeq}), 0) + 1`,
        }).from(schema.messages).where(eq(schema.messages.ticketId, ticketId)).get())?.n ?? 1;
        const createdAt = nowIso();
        const hashid = pickFreshHashid(tx);
        const ev = tx.insert(schema.messages).values({
            id,
            ticketId,
            displaySeq: mseq,
            kind: "comment_added",
            body: `🔀 Ticket moved from \`${from}\` to \`${targetProject}\`.`,
            byAgent: byAgent ?? null,
            status: "approved",
            decidedAt: createdAt,
            decidedBy: "auto",
            createdAt,
            hashid,
            meta: JSON.stringify({ moved: { from, to: targetProject, by: byAgent ?? null } }),
        }).returning().get();
        return {
            ticket: ticketRowToMessage(moved),
            event: messageRowToMessage(ev, targetProject),
            from,
        };
    });
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
        // #B.153: dedupe ticket_referenced. The same source can mention
        // the target multiple times — once at creation, then again in
        // edited bodies / new comments. The first event already records
        // the relationship; subsequent ones add noise without info.
        // ticket_sub_added is naturally one-shot (per parent_id set),
        // no dedup needed there.
        if (opts.kind === "ticket_referenced") {
            const existing = tx.select({ id: schema.messages.id })
                .from(schema.messages)
                .where(and(
                    eq(schema.messages.ticketId, opts.target_ticket_id),
                    eq(schema.messages.kind, "ticket_referenced"),
                    eq(schema.messages.sourceTicketId, opts.source_ticket_id),
                ))
                .get();
            if (existing) return null;
        }
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

/**
 * Insert a typed inter-ticket relation event (#B.123 phase B).
 * Stores kind = `ticket_relation` with `meta.relation = {kind,
 * target_ticket_id}` on the source ticket's thread. Append-only:
 * to change a relation's kind, post a new event; the latest event
 * per (source, target) tuple wins. To remove, post with
 * `kind = "ignored"` (acts as a tombstone in the replay).
 *
 * Inserted as `approved` with `decided_by=auto` — typed relations
 * don't go through moderation (the audit lives in the message log).
 */
import { inverseRelationKind, type RelationKind } from "../relations.js";
export function insertTypedRelation(opts: {
    source_ticket_id: number;
    target_ticket_id: number;
    relation_kind: RelationKind;
    by_agent: string | null;
}): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const id = nextMessageId(tx);
        const seq = (tx.select({
            n: sql<number>`COALESCE(MAX(${schema.messages.displaySeq}), 0) + 1`,
        }).from(schema.messages).where(eq(schema.messages.ticketId, opts.source_ticket_id)).get())?.n ?? 1;
        const createdAt = nowIso();
        const hashid = pickFreshHashid(tx);
        const meta: MessageMeta = {
            relation: {
                kind: opts.relation_kind,
                target_ticket_id: opts.target_ticket_id,
            },
        };
        const inserted = tx.insert(schema.messages).values({
            id,
            ticketId: opts.source_ticket_id,
            displaySeq: seq,
            kind: "ticket_relation",
            body: "",
            byAgent: opts.by_agent ?? null,
            status: "approved",
            decidedAt: createdAt,
            decidedBy: "auto",
            createdAt,
            hashid,
            sourceTicketId: opts.target_ticket_id,
            meta: serializeMeta(meta),
        }).returning().get();
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, opts.source_ticket_id)).get();
        return messageRowToMessage(inserted, parent?.project ?? "");
    });
}

/**
 * Replay all `ticket_relation` events on a ticket and return the
 * effective relation set: for each (source, target) pair, take the
 * latest event; drop tombstones (kind=ignored). Returns the active
 * relations sorted by most-recently-modified first.
 */
export interface ActiveRelation {
    target_ticket_id: number;
    kind: RelationKind;
    last_event_id: number;
    last_event_at: string;
    by_agent: string | null;
    /** #B.197: true when the chip is the reverse view of an event
     *  authored from the OTHER ticket (e.g. "#196 blocks #189"
     *  shows on #189 as `depends_on #196` with reciprocal=true).
     *  The kind here is `inverseRelationKind(original)`. Direct
     *  events have reciprocal absent/false. */
    reciprocal?: boolean;
}
export function listTypedRelationsForTicket(ticketId: number): ActiveRelation[] {
    const db = getDb();
    // Direct edges: events authored ON this ticket pointing to a target.
    const direct = db.select({
        id: schema.messages.id,
        createdAt: schema.messages.createdAt,
        byAgent: schema.messages.byAgent,
        sourceTicketId: schema.messages.sourceTicketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.ticketId, ticketId),
            eq(schema.messages.kind, "ticket_relation"),
            eq(schema.messages.status, "approved"),
        ))
        .orderBy(schema.messages.id)
        .all();
    // Latest-event-wins per (target). Key on target_ticket_id since
    // a ticket may have at most one active relation per target — the
    // user changes kinds by posting a fresh event, not by adding more.
    const latestByTarget = new Map<number, ActiveRelation & { kindIsTombstone: boolean }>();
    for (const r of direct) {
        if (!r.meta) continue;
        let parsedKind: string | undefined;
        try {
            const m = JSON.parse(r.meta) as { relation?: { kind?: string } };
            parsedKind = m.relation?.kind;
        } catch { continue; }
        const target = r.sourceTicketId; // target stored in sourceTicketId per insertTypedRelation
        if (!target || !parsedKind) continue;
        latestByTarget.set(target, {
            target_ticket_id: target,
            kind: parsedKind as RelationKind,
            last_event_id: r.id,
            last_event_at: r.createdAt,
            by_agent: r.byAgent,
            kindIsTombstone: parsedKind === "ignored",
        });
    }
    // Reciprocal edges (#B.197): events authored on OTHER tickets that
    // point AT this ticket. Persisted one-way (relations.ts line 49
    // "don't auto-flip on insert"), but semantically symmetric — a
    // `blocks A→B` event means B is `depends_on A`. Pull the reverse
    // pile, inverse the kind, expose with reciprocal=true so the
    // frontend can render them visually distinct.
    const reverse = db.select({
        id: schema.messages.id,
        createdAt: schema.messages.createdAt,
        byAgent: schema.messages.byAgent,
        ticketId: schema.messages.ticketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.sourceTicketId, ticketId),
            eq(schema.messages.kind, "ticket_relation"),
            eq(schema.messages.status, "approved"),
        ))
        .orderBy(schema.messages.id)
        .all();
    const latestByOriginator = new Map<number, ActiveRelation & { kindIsTombstone: boolean }>();
    for (const r of reverse) {
        if (!r.meta || !r.ticketId) continue;
        let parsedKind: string | undefined;
        try {
            const m = JSON.parse(r.meta) as { relation?: { kind?: string } };
            parsedKind = m.relation?.kind;
        } catch { continue; }
        if (!parsedKind) continue;
        const inversed = inverseRelationKind(parsedKind as RelationKind);
        latestByOriginator.set(r.ticketId, {
            target_ticket_id: r.ticketId,
            kind: inversed,
            last_event_id: r.id,
            last_event_at: r.createdAt,
            by_agent: r.byAgent,
            reciprocal: true,
            kindIsTombstone: parsedKind === "ignored",
        });
    }
    // Dedup: if a direct relation already exists for the same target
    // with the same effective kind, skip the reciprocal (symmetric
    // kinds collide trivially; blocks/depends_on collide when both
    // sides recorded the relation explicitly).
    for (const [originator, rel] of latestByOriginator) {
        const directHit = latestByTarget.get(originator);
        if (directHit && directHit.kind === rel.kind && !directHit.kindIsTombstone) continue;
        // Don't let a reciprocal override a tombstoned direct event —
        // the user explicitly removed that link from this side.
        if (directHit && directHit.kindIsTombstone) continue;
        latestByTarget.set(originator, rel);
    }
    return Array.from(latestByTarget.values())
        .filter((r) => !r.kindIsTombstone)
        .map(({ kindIsTombstone: _, ...rest }) => rest)
        .sort((a, b) => b.last_event_id - a.last_event_id);
}

/**
 * Cycle guard for lineage edges (#275). Returns true if adding the edge
 * "childId child_of parentId" would close a loop — i.e. childId is
 * already an ancestor of parentId (walking `child_of` edges upward from
 * parentId via the active relation set). The relations endpoint uses it
 * to reject pathological lineage that the manual MCP/UI path could
 * otherwise introduce; auto sub-ticket creation can't trip it (a fresh
 * child has no descendants yet). A `parent_of` request is the mirror —
 * the caller swaps (child, parent).
 *
 * The `seen` set also makes the walk terminate on a pre-existing cycle
 * (defensive — the guard should keep the graph acyclic, but a legacy row
 * shouldn't hang the daemon).
 */
export function lineageWouldCycle(childId: number, parentId: number): boolean {
    const seen = new Set<number>();
    const stack: number[] = [parentId];
    while (stack.length) {
        const cur = stack.pop()!;
        if (cur === childId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const rel of listTypedRelationsForTicket(cur)) {
            if (rel.kind === "child_of") stack.push(rel.target_ticket_id);
        }
    }
    return false;
}

/**
 * One-shot migration: backfill `child_of` lineage relations from the
 * legacy `parent_ticket_id` FK column (#271). For every ticket with
 * `parent_ticket_id` set, ensure a `child_of` event exists from the
 * child to the parent (the parent sees the reciprocal `parent_of`).
 *
 * Supersedes the #B.123 phase B.3 backfill, which seeded `depends_on`
 * for the same pairs — semantically wrong (a sub-ticket isn't *blocked*
 * by its parent) and it spuriously gated sub-tickets out of `actionable`
 * while the parent stayed open. This pass UPGRADES those system-authored
 * `depends_on` events to `child_of`: a fresh event with a higher id wins
 * the latest-per-pair replay, which both retags the chip and clears the
 * gate (child_of is inert for gating). User-authored relations between a
 * child/parent pair are left untouched.
 *
 * Called at daemon boot. Idempotent — re-runs find the `child_of` already
 * in place and skip. Best-effort: per-row failures are swallowed so a
 * malformed sidecar doesn't kill the daemon. Returns the number of
 * relations newly inserted (0 on a settled re-run).
 *
 * The legacy column stays in the schema (write-only) for now; Phase 3
 * (#271) drops it once we're confident the read paths agree.
 */
export function backfillParentTicketRelations(): number {
    const db = getDb();
    const parents = db.select({
        id: schema.tickets.id,
        parent: schema.tickets.parentTicketId,
    })
        .from(schema.tickets)
        .all()
        .filter((r) => r.parent !== null);

    let inserted = 0;
    for (const t of parents) {
        const parent = t.parent;
        if (parent === null) continue;
        // Latest active ticket_relation event for this (child → parent)
        // pair — drives the latest-per-target replay.
        const existing = db.select({
            meta: schema.messages.meta,
            byAgent: schema.messages.byAgent,
            id: schema.messages.id,
        })
            .from(schema.messages)
            .where(and(
                eq(schema.messages.ticketId, t.id),
                eq(schema.messages.kind, "ticket_relation"),
                eq(schema.messages.status, "approved"),
                eq(schema.messages.sourceTicketId, parent),
            ))
            .orderBy(desc(schema.messages.id))
            .limit(1)
            .get();
        if (existing) {
            let kind: string | undefined;
            try {
                kind = (JSON.parse(existing.meta ?? "{}") as { relation?: { kind?: string } }).relation?.kind;
            } catch { kind = undefined; }
            // Already migrated → idempotent no-op.
            if (kind === "child_of") continue;
            // User explicitly set a relation between this pair — respect
            // their choice, don't clobber it with auto lineage.
            if (existing.byAgent !== null) continue;
            // Else: the legacy system-authored `depends_on` backfill —
            // fall through to insert a `child_of` that supersedes it.
        }
        try {
            insertTypedRelation({
                source_ticket_id: t.id,
                target_ticket_id: parent,
                relation_kind: "child_of",
                by_agent: null, // system-authored backfill
            });
            inserted++;
        } catch {
            /* row-level failure, skip */
        }
    }
    return inserted;
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
/**
 * Set or clear the `meta.summary_until` one-liner on a comment
 * (#B.130). Empty string → drop the field. Returns the updated
 * message or null when the id doesn't resolve. Caller permissioning
 * is upstream (any participant can summarize; the audit is in the
 * who-edited-when of the row's updated_at, not in meta itself —
 * keeping summary cheap to write).
 */
export function setMessageSummary(
    messageId: number,
    summary: string,
): Message | null {
    const trimmed = summary.trim().slice(0, 200);
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        if (m.kind !== "comment_added") {
            throw new Error("summary is only meaningful on comments");
        }
        const meta = parseMeta(m.meta ?? null);
        if (!trimmed) {
            delete meta.summary_until;
        } else {
            meta.summary_until = trimmed;
        }
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

/**
 * #518 (david `uzwfc3` MVP option A) — set/clear a vote (binary +1/-1)
 * on a comment, per-author (1 vote/consumer). Value 0 retracts the
 * voter's existing vote (delete entry from meta.votes). Throws on a
 * non-comment target (votes are comment-only — tickets carry their
 * own lifecycle via resolved/blocked/close, no need for thumbs).
 * Returns the updated message or null if id doesn't exist.
 */
export function setMessageVote(
    messageId: number,
    consumerId: string,
    value: 1 | -1 | 0,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        if (m.kind !== "comment_added") {
            throw new Error("votes are only meaningful on comments");
        }
        const meta = parseMeta(m.meta ?? null);
        const votes = { ...(meta.votes ?? {}) };
        if (value === 0) {
            delete votes[consumerId];
        } else {
            votes[consumerId] = value;
        }
        if (Object.keys(votes).length === 0) {
            delete meta.votes;
        } else {
            meta.votes = votes;
        }
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

/**
 * Reclassify a comment's decision kind without changing its status
 * (#B.129 follow-up). Throws when the decision is missing or already
 * terminal. HTTP layer maps to 409 on conflict.
 */
export function reclassifyMessageDecision(
    messageId: number,
    newKind: import("../decisions.js").DecisionKind,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        const meta = parseMeta(m.meta ?? null);
        const r = reclassifyDecision(meta.decision, newKind);
        if (!r.changed) {
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

/**
 * Promote an undecorated comment to a decision (#B.256). When the
 * comment has no prior `meta.decision`, this creates one (pending if
 * `status` is omitted, terminal if "accepted" / "rejected" is passed).
 * When it already has a decision, delegates to reclassify (status
 * omitted) or applyDecision (status set) so the same endpoint can
 * funnel both flows.
 *
 * Throws when the existing decision is already terminal AND the new
 * status would change it — the post-hoc gesture isn't supposed to
 * undo a final decision (re-tag requires a new comment).
 */
export function promoteMessageToDecision(
    messageId: number,
    kind: import("../decisions.js").DecisionKind,
    status: Exclude<DecisionStatus, "pending"> | undefined,
    by: string,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        if (m.kind !== "comment_added") {
            throw new Error("promote only applies to comment_added");
        }
        const meta = parseMeta(m.meta ?? null);
        const at = new Date().toISOString();
        const r = promoteToDecision(meta.decision, kind, status, by, at);
        if (!r.changed) {
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

/**
 * Untag a comment — drops `meta.decision` entirely (#B.256 dzm3ef).
 * Idempotent (no-op when nothing to remove). Throws when the
 * existing decision is already terminal — the audit row stays in
 * the thread, removal would erase that history. Pending decisions
 * can be cleanly removed.
 */
export function removeMessageDecision(messageId: number): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        const meta = parseMeta(m.meta ?? null);
        if (!meta.decision) {
            const parent = tx.select({ project: schema.tickets.project })
                .from(schema.tickets).where(eq(schema.tickets.id, m.ticketId)).get();
            return messageRowToMessage(m, parent?.project ?? "");
        }
        if (meta.decision.status !== "pending") {
            throw new Error(
                `cannot remove a ${meta.decision.status} decision — the audit row must persist`,
            );
        }
        meta.decision = undefined;
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

/**
 * #697 F5 (pisynth-claude #692) — "ball in MY court" lens. Lists every
 * pending decision (plan or resolution) waiting on the given consumer
 * for accept / reject. Defined as : approved `comment_added` rows on
 * OPEN tickets the consumer reports, whose `meta.decision.status` is
 * "pending". Returns one row per decision with the bits the agent needs
 * to triage : the comment's id + hashid + author + summary_until, plus
 * the parent ticket's id + title + project.
 *
 * Sorted by created_at descending (most recent first) so the freshest
 * proposals surface at the top — agents triage what just landed before
 * trawling older drafts.
 */
export interface PendingDecisionEntry {
    comment_id: number;
    comment_hashid: string | null;
    ticket_id: number;
    ticket_title: string;
    ticket_project: string;
    decision_kind: "plan" | "resolution";
    proposed_by: string | null;
    created_at: string;
    summary_until: string | null;
}

export function listPendingDecisionsForReporter(
    consumerId: string,
): PendingDecisionEntry[] {
    const db = getDb();
    const myTickets = db.select({
        id: schema.tickets.id,
        title: schema.tickets.title,
        project: schema.tickets.project,
    })
        .from(schema.tickets)
        .where(eq(schema.tickets.byAgent, consumerId))
        .all();
    // Closed-ticket pending decisions get auto-handled by
    // `autoApproveStaleDecisionsOnClose` (api/messages.ts) at close time,
    // so no extra filter is needed — anything still pending here is on
    // an actively-open thread.
    if (myTickets.length === 0) return [];
    const ticketIndex = new Map(myTickets.map((t) => [t.id, t]));
    const ticketIds = myTickets.map((t) => t.id);
    const candidates = db.select().from(schema.messages)
        .where(and(
            inArray(schema.messages.ticketId, ticketIds),
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const out: PendingDecisionEntry[] = [];
    for (const r of candidates) {
        if (!r.meta) continue;
        try {
            const m = JSON.parse(r.meta) as {
                decision?: { kind?: string; status?: string };
                summary_until?: string;
            };
            const kind = m.decision?.kind;
            if ((kind === "plan" || kind === "resolution")
                && m.decision?.status === "pending") {
                const t = ticketIndex.get(r.ticketId)!;
                out.push({
                    comment_id: r.id,
                    comment_hashid: r.hashid ?? null,
                    ticket_id: r.ticketId,
                    ticket_title: t.title,
                    ticket_project: t.project,
                    decision_kind: kind,
                    proposed_by: r.byAgent ?? null,
                    created_at: r.createdAt,
                    summary_until: m.summary_until ?? null,
                });
            }
        } catch { /* malformed meta, skip */ }
    }
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
}

/**
 * Find all approved comments on a ticket that carry a pending
 * `meta.decision.kind=="resolution"` block. Used when the ticket
 * closes to auto-accept the proposals (mirror of the legacy
 * `listPendingResolvedForTicket` flow for `ticket_resolved` rows).
 */
export function listPendingResolutionDecisionsForTicket(
    ticketId: number,
): Message[] {
    const db = getDb();
    const rows = db.select().from(schema.messages)
        .where(and(
            eq(schema.messages.ticketId, ticketId),
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const out: Message[] = [];
    for (const r of rows) {
        if (!r.meta) continue;
        try {
            const m = JSON.parse(r.meta) as { decision?: { kind?: string; status?: string } };
            if (m.decision?.kind === "resolution" && m.decision.status === "pending") {
                const parent = db.select({ project: schema.tickets.project })
                    .from(schema.tickets).where(eq(schema.tickets.id, r.ticketId)).get();
                out.push(messageRowToMessage(r, parent?.project ?? ""));
            }
        } catch { /* malformed meta, skip */ }
    }
    return out;
}

export function applyMessageDecision(
    messageId: number,
    status: DecisionStatus,
    decidedBy: string,
    /** Optional reclassification (#B.129 follow-up): pass to change
     *  `meta.decision.kind` at the moment of decide. Useful when the
     *  reporter wants to accept a comment tagged as a resolution as a
     *  plan instead (or vice versa). */
    newKind?: import("../decisions.js").DecisionKind,
): Message | null {
    const db = getDb();
    return db.transaction((tx) => {
        const m = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!m) return null;
        const meta = parseMeta(m.meta ?? null);
        const decidedAt = new Date().toISOString();
        const r = applyDecision(meta.decision, status, decidedBy, decidedAt, newKind);
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
        // #374: accepting/rejecting a decision is an ACTION by the decider —
        // they're now the ticket's last actor (this is what makes a reopened
        // bug / accepted plan return to the agent's court). `auto` deciders
        // (e.g. dangling-resolution auto-accept on close) are skipped.
        bumpLastActor(tx, m.ticketId, decidedBy, decidedAt);
        const fresh = tx.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!fresh) return null;
        const parent = tx.select({ project: schema.tickets.project })
            .from(schema.tickets).where(eq(schema.tickets.id, fresh.ticketId)).get();
        return messageRowToMessage(fresh, parent?.project ?? "");
    });
}
