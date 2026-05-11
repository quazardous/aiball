import {
    and,
    asc,
    desc,
    eq,
    inArray,
    isNull,
    isNotNull,
    lte,
    ne,
    or,
    sql,
} from "drizzle-orm";
import * as schema from "./schema.js";
import {
    getDb,
    nowIso,
    nextGlobalId,
    pickFreshHashid,
    ticketRowToMessage,
    messageRowToMessage,
    type Message,
    type MessageKind,
    type MessageStatus,
    type RuleDecision,
    type Intent,
    type SubscriptionRole,
    type Subscription,
    type Rule,
    type NewMessage,
    type NewRule,
} from "./db/connection.js";

// =====================================================================
//                  Re-exports — public API surface
// =====================================================================
//
// db.ts started life as a monolith holding both the DB plumbing and
// every domain-specific helper. Phase A of #B.332 split it: connection
// + types live in ./db/connection.ts, the catalog tables (tags,
// settings, uploads) live in their own modules. The rest stays here
// until later phases extract them too. The re-exports below keep the
// public API stable for callers (api.ts, mcp.ts, messages.ts, …) that
// import everything from "./db.js".

export {
    getDb,
    getRawSqlite,
    nowIso,
    INTENTS,
    type Message,
    type MessageKind,
    type MessageStatus,
    type RuleDecision,
    type Intent,
    type TicketRow,
    type MessageRow,
    type SubscriptionRole,
    type Subscription,
    type Rule,
    type NewMessage,
    type NewRule,
} from "./db/connection.js";

export {
    DEFAULT_STRATEGY,
    STRATEGIES,
    type Strategy,
    getSetting,
    setSetting,
    getStrategy,
    setStrategy,
    UPLOAD_HARD_CAP_BYTES,
    DEFAULT_UPLOAD_MAX_BYTES,
    getUploadMaxBytes,
    setUploadMaxBytes,
} from "./db/settings.js";

export {
    type UploadRow,
    type UploadInsert,
    type UploadStats,
    insertUpload,
    uploadStats,
    listOrphanUploads,
    deleteUploadRow,
} from "./db/uploads.js";

export {
    type Tag,
    type NewTag,
    listTags,
    getTag,
    getTagByName,
    insertTag,
    updateTag,
    deleteTag,
    listMessageTags,
    tagsForMessages,
    addMessageTag,
    removeMessageTag,
    setMessageTags,
} from "./db/tags.js";

// =====================================================================
// Messages — public API (legacy signatures, internally routed to the
// right physical table).
// =====================================================================

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

// =====================================================================
// Projects
// =====================================================================

export function listProjects(): string[] {
    const db = getDb();
    const rows = db.selectDistinct({ project: schema.tickets.project })
        .from(schema.tickets)
        .orderBy(asc(schema.tickets.project))
        .all();
    return rows.map((r) => r.project);
}

export interface ProjectMeta {
    name: string;
    last_activity: string;
    ticket_count: number;
    comment_count: number;
    pending_count: number;
    /** Unread pings the given consumer has on this project. Set only when
     *  listProjectsDetailed is called with a consumer_id. */
    unread_for_consumer?: number;
    /** Approved tickets currently in an open lifecycle state (i.e. no
     *  terminal close, not snoozed). Independent of the moderation pending_count. */
    open_count?: number;
    /** Approved tickets currently snoozed (postponed_until > now). Excluded
     *  from open_count above; surfaced separately so the UI can toggle a
     *  "show snoozed" mode that merges the two counts (per #B.329). */
    snoozed_count?: number;
    /** Approved+open tickets with at least one PENDING `ticket_resolved`
     *  proposal — the reporter needs to accept-and-close (or reject) it. */
    resolved_count?: number;
}

export function listProjectsDetailed(consumer_id?: string): ProjectMeta[] {
    const db = getDb();
    // Aggregates by project across tickets + messages. Two queries merged
    // in JS — small data sizes, simpler than a SQL UNION/GROUP dance.
    const ticketAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.tickets.createdAt})`,
        ticket_count: sql<number>`COUNT(*)`,
        ticket_pending: sql<number>`SUM(CASE WHEN ${schema.tickets.status} = 'pending' THEN 1 ELSE 0 END)`,
    }).from(schema.tickets).groupBy(schema.tickets.project).all();

    // pending_count == "moderation backlog the human needs to look at".
    // Only `comment_added` lifecycle counts here — pending lifecycle events
    // (ticket_resolved / ticket_closed / ticket_reopened) are not part of
    // the moderation queue. ticket_resolved pendings surface as a separate
    // `pending_resolution` row tint in the inbox (action on the reporter,
    // not the moderator). Pending ticket_closed/reopened on already-closed
    // tickets are moot and get auto-rejected by submitMessage forward, plus
    // backfill-rejected as a one-shot.
    const messageAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.messages.createdAt})`,
        comment_count: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' THEN 1 ELSE 0 END)`,
        message_pending: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' AND ${schema.messages.status} = 'pending' THEN 1 ELSE 0 END)`,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .groupBy(schema.tickets.project)
        .all();

    const byProject = new Map<string, ProjectMeta>();
    for (const t of ticketAgg) {
        byProject.set(t.project, {
            name: t.project,
            last_activity: t.last_activity ?? "",
            ticket_count: Number(t.ticket_count),
            comment_count: 0,
            pending_count: Number(t.ticket_pending) || 0,
        });
    }
    for (const m of messageAgg) {
        const cur = byProject.get(m.project);
        const lastActivity = m.last_activity ?? "";
        if (cur) {
            cur.comment_count = Number(m.comment_count) || 0;
            cur.pending_count += Number(m.message_pending) || 0;
            if (lastActivity > cur.last_activity) cur.last_activity = lastActivity;
        } else {
            byProject.set(m.project, {
                name: m.project,
                last_activity: lastActivity,
                ticket_count: 0,
                comment_count: Number(m.comment_count) || 0,
                pending_count: Number(m.message_pending) || 0,
            });
        }
    }
    // Lifecycle replay across (closed/reopened) events in id order so we
    // know which tickets are currently closed.
    const lifecycle = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    const closedByTicket = new Map<number, boolean>();
    for (const ev of lifecycle) {
        closedByTicket.set(ev.ticket_id, ev.kind === "ticket_closed");
    }

    // Pending resolution proposals: tickets with at least one
    // `ticket_resolved` row in status=pending awaiting moderator
    // accept/reject. The sidebar badge surfaces this as "I have a
    // decision to make" — the user explicitly asked for the green count
    // to map to *waiting on my accept*, not to *already accepted*.
    const pendingResolveds = db.select({
        project: schema.tickets.project,
        ticket_id: schema.messages.ticketId,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.messages.kind, "ticket_resolved"),
            eq(schema.messages.status, "pending"),
        ))
        .all();
    const pendingResolutionTickets = new Map<string, Set<number>>();
    for (const r of pendingResolveds) {
        let s = pendingResolutionTickets.get(r.project);
        if (!s) {
            s = new Set();
            pendingResolutionTickets.set(r.project, s);
        }
        s.add(r.ticket_id);
    }

    const openCounts = db.select({
        project: schema.tickets.project,
        id: schema.tickets.id,
        status: schema.tickets.status,
        postponedUntil: schema.tickets.postponedUntil,
    }).from(schema.tickets).all();
    const nowStr = nowIso();
    const openPerProject = new Map<string, number>();
    const snoozedPerProject = new Map<string, number>();
    for (const t of openCounts) {
        if (t.status !== "approved") continue;
        const closedByLifecycle = closedByTicket.get(t.id) === true;
        if (closedByLifecycle) continue;
        const snoozed = !!t.postponedUntil && t.postponedUntil > nowStr;
        if (snoozed) {
            snoozedPerProject.set(t.project, (snoozedPerProject.get(t.project) ?? 0) + 1);
            continue;
        }
        openPerProject.set(t.project, (openPerProject.get(t.project) ?? 0) + 1);
    }
    for (const p of byProject.values()) {
        p.open_count = openPerProject.get(p.name) ?? 0;
        p.snoozed_count = snoozedPerProject.get(p.name) ?? 0;
        // Filter the pending-resolution set to only ticket ids whose
        // parent ticket is open + approved (otherwise a stale proposal
        // on a closed ticket would inflate the count).
        const candidates = pendingResolutionTickets.get(p.name);
        if (!candidates) {
            p.resolved_count = 0;
        } else {
            let n = 0;
            for (const tid of candidates) {
                const t = openCounts.find((x) => x.id === tid);
                if (!t || t.status !== "approved") continue;
                if (closedByTicket.get(tid) === true) continue;
                n++;
            }
            p.resolved_count = n;
        }
    }

    if (consumer_id) {
        // Per-project unread for this consumer = **count of distinct OPEN
        // tickets** that have at least one unseen ping (NOT count of pings,
        // and **closed/rejected tickets are excluded**). This matches the
        // default "Unread" filter in the UI, which lives behind the
        // `onlyOpen=true` filter most of the time — so the sidebar badge
        // and the row list agree on the same number.
        //
        // Two sources of ticket ids: pings on the ticket-root, pings on
        // any of its comments. Merge into a Set per project, then drop
        // tickets that the lifecycle replay above flagged as closed.
        // Self-pings are filtered (an agent's own posts don't count as
        // unread for themselves).
        const ticketIdsFromTicketPings = db.select({
            ticket_id: schema.tickets.id,
            project: schema.tickets.project,
        })
            .from(schema.pings)
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
                or(
                    isNull(schema.tickets.byAgent),
                    ne(schema.tickets.byAgent, consumer_id),
                ),
            ))
            .all();
        const ticketIdsFromCommentPings = db.select({
            ticket_id: schema.messages.ticketId,
            project: schema.tickets.project,
        })
            .from(schema.pings)
            .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
                or(
                    isNull(schema.messages.byAgent),
                    ne(schema.messages.byAgent, consumer_id),
                ),
            ))
            .all();
        const ticketStatusById = new Map<number, string>();
        for (const t of openCounts) ticketStatusById.set(t.id, t.status);
        const byProjectSets = new Map<string, Set<number>>();
        function note(project: string, ticket_id: number) {
            // Skip tickets the user can't act on directly: closed via
            // lifecycle, or moderation-rejected.
            const status = ticketStatusById.get(ticket_id);
            if (status === "rejected") return;
            if (closedByTicket.get(ticket_id) === true) return;
            let s = byProjectSets.get(project);
            if (!s) {
                s = new Set();
                byProjectSets.set(project, s);
            }
            s.add(ticket_id);
        }
        for (const r of ticketIdsFromTicketPings) note(r.project, r.ticket_id);
        for (const r of ticketIdsFromCommentPings) note(r.project, r.ticket_id);
        for (const p of byProject.values()) {
            p.unread_for_consumer = byProjectSets.get(p.name)?.size ?? 0;
        }
    }

    return [...byProject.values()].sort((a, b) =>
        b.last_activity.localeCompare(a.last_activity),
    );
}

/**
 * Hard-delete a project: every ticket (cascades to _messages, ticket_tags,
 * ticket_subscriptions via FK), every project subscription, every ping
 * targeting any of those ids (no FK on pings; cleanup is explicit).
 */
export function deleteProject(name: string): { deleted_messages: number } {
    const db = getDb();
    return db.transaction((tx) => {
        const ticketIds = tx.select({ id: schema.tickets.id })
            .from(schema.tickets).where(eq(schema.tickets.project, name)).all()
            .map((r) => r.id);
        let messageIds: number[] = [];
        if (ticketIds.length) {
            messageIds = tx.select({ id: schema.messages.id })
                .from(schema.messages)
                .where(inArray(schema.messages.ticketId, ticketIds))
                .all()
                .map((r) => r.id);
        }
        const allIds = [...ticketIds, ...messageIds];
        if (allIds.length) {
            tx.delete(schema.pings).where(inArray(schema.pings.messageId, allIds)).run();
        }
        tx.delete(schema.tickets).where(eq(schema.tickets.project, name)).run();
        tx.delete(schema.subscriptions).where(eq(schema.subscriptions.project, name)).run();
        return { deleted_messages: ticketIds.length + messageIds.length };
    });
}

// =====================================================================
// Rules
// =====================================================================

export function insertRule(r: NewRule): Rule {
    const db = getDb();
    const inserted = db.insert(schema.rules).values({
        position: r.position ?? 0,
        matchProject: r.match_project ?? null,
        matchKind: r.match_kind ?? null,
        matchByAgent: r.match_by_agent ?? null,
        decision: r.decision,
        enabled: 1,
        note: r.note ?? null,
        createdAt: nowIso(),
    }).returning().get();
    return ruleRowToRule(inserted);
}

function ruleRowToRule(r: schema.Rule): Rule {
    return {
        id: r.id,
        position: r.position,
        match_project: r.matchProject,
        match_kind: (r.matchKind as MessageKind | null) ?? null,
        match_by_agent: r.matchByAgent,
        decision: r.decision as RuleDecision,
        enabled: r.enabled,
        note: r.note,
        created_at: r.createdAt,
    };
}

export function listRules(opts: { enabledOnly?: boolean } = {}): Rule[] {
    const db = getDb();
    let q = db.select().from(schema.rules).$dynamic();
    if (opts.enabledOnly) q = q.where(eq(schema.rules.enabled, 1));
    return q.orderBy(asc(schema.rules.position), asc(schema.rules.id)).all().map(ruleRowToRule);
}

export function deleteRule(id: number): void {
    getDb().delete(schema.rules).where(eq(schema.rules.id, id)).run();
}

export function setRuleEnabled(id: number, enabled: boolean): Rule | null {
    const db = getDb();
    db.update(schema.rules).set({ enabled: enabled ? 1 : 0 })
        .where(eq(schema.rules.id, id)).run();
    const r = db.select().from(schema.rules).where(eq(schema.rules.id, id)).get();
    return r ? ruleRowToRule(r) : null;
}

// =====================================================================
// Project subscriptions
// =====================================================================

/**
 * Upsert a project subscription. If a row already exists and `role` is
 * provided, the role is updated to the new value (so an agent can promote
 * itself from follower to owner without unsubscribing first). Without an
 * explicit role argument the existing row is left untouched, and new rows
 * default to follower.
 */
export function upsertSubscription(
    consumer_id: string,
    project: string,
    role?: SubscriptionRole,
): Subscription {
    const db = getDb();
    const existing = db.select().from(schema.subscriptions)
        .where(and(
            eq(schema.subscriptions.consumerId, consumer_id),
            eq(schema.subscriptions.project, project),
        )).get();
    if (existing) {
        if (role && role !== existing.role) {
            db.update(schema.subscriptions)
                .set({ role })
                .where(and(
                    eq(schema.subscriptions.consumerId, consumer_id),
                    eq(schema.subscriptions.project, project),
                )).run();
            existing.role = role;
        }
        return {
            consumer_id: existing.consumerId,
            project: existing.project,
            subscribed_at: existing.subscribedAt,
            last_seen_id: existing.lastSeenId,
            role: (existing.role ?? "follower") as SubscriptionRole,
        };
    }
    db.insert(schema.subscriptions).values({
        consumerId: consumer_id,
        project,
        subscribedAt: nowIso(),
        lastSeenId: 0, // dormant, kept for column compat
        role: role ?? "follower",
    }).run();
    const fresh = db.select().from(schema.subscriptions)
        .where(and(
            eq(schema.subscriptions.consumerId, consumer_id),
            eq(schema.subscriptions.project, project),
        )).get();
    return {
        consumer_id: fresh!.consumerId,
        project: fresh!.project,
        subscribed_at: fresh!.subscribedAt,
        last_seen_id: fresh!.lastSeenId,
        role: (fresh!.role ?? "follower") as SubscriptionRole,
    };
}

export function deleteSubscription(consumer_id: string, project: string): void {
    getDb().delete(schema.subscriptions).where(and(
        eq(schema.subscriptions.consumerId, consumer_id),
        eq(schema.subscriptions.project, project),
    )).run();
}

export function listSubscriptions(consumer_id?: string): Subscription[] {
    const db = getDb();
    let q = db.select().from(schema.subscriptions).$dynamic();
    if (consumer_id) q = q.where(eq(schema.subscriptions.consumerId, consumer_id));
    return q.orderBy(asc(schema.subscriptions.consumerId), asc(schema.subscriptions.project))
        .all()
        .map((r) => ({
            consumer_id: r.consumerId,
            project: r.project,
            subscribed_at: r.subscribedAt,
            last_seen_id: r.lastSeenId,
            role: (r.role ?? "follower") as SubscriptionRole,
        }));
}

/**
 * Project subscribers, optionally filtered by role. Without filter you get
 * everyone; with `roles: ["owner"]` only the project maintainers; with
 * `roles: ["follower"]` only the broadcast-only subscribers.
 *
 * fanOutPings uses this to send broadcast tickets to everyone but keep
 * internal-only tickets visible to owners only.
 */
export function listProjectSubscribers(
    project: string,
    opts: { roles?: SubscriptionRole[] } = {},
): string[] {
    const db = getDb();
    const filters = [eq(schema.subscriptions.project, project)];
    if (opts.roles && opts.roles.length > 0) {
        filters.push(inArray(schema.subscriptions.role, opts.roles));
    }
    return db.select({ consumer_id: schema.subscriptions.consumerId })
        .from(schema.subscriptions)
        .where(and(...filters))
        .all()
        .map((r) => r.consumer_id);
}

/**
 * Lean per-project stats used by `ticket_new` to surface subscriber
 * counts in the response (« nobody is listening » hint per #B.215).
 * Cheap enough to fire on every post — three indexed SUMs.
 */
export interface ProjectStats {
    project: string;
    owners: number;
    followers: number;
    ticket_count: number;
    comment_count: number;
}

export function getProjectStats(project: string): ProjectStats {
    const db = getDb();
    const subs = db.select({
        owners: sql<number>`SUM(CASE WHEN ${schema.subscriptions.role} = 'owner' THEN 1 ELSE 0 END)`,
        followers: sql<number>`SUM(CASE WHEN ${schema.subscriptions.role} = 'follower' THEN 1 ELSE 0 END)`,
    }).from(schema.subscriptions)
        .where(eq(schema.subscriptions.project, project))
        .get();
    const tickets = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.tickets)
        .where(eq(schema.tickets.project, project))
        .get();
    const comments = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.messages.kind, "comment_added"),
        ))
        .get();
    return {
        project,
        owners: Number(subs?.owners ?? 0),
        followers: Number(subs?.followers ?? 0),
        ticket_count: Number(tickets?.n ?? 0),
        comment_count: Number(comments?.n ?? 0),
    };
}

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
//                  Postpone / snooze (per #B.329)
// =====================================================================

/**
 * Snooze a ticket until the given ISO8601 timestamp. While the ticket is
 * snoozed, it's hidden from the open inbox (treated as closed for
 * filtering). The daemon's reveal cron clears the field at the deadline
 * and posts a synthetic `ticket_reopened` so the ticket bounces back.
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
 * clear the field and post a `ticket_reopened` for each. Cheap query
 * — uses the `idx_tickets_postponed` index.
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

// =====================================================================
// Inbox / unread (backed by pings, joined with messages or tickets)
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

// =====================================================================
// Pings (lineage + transition)
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

// =====================================================================
// Ticket subscriptions
// =====================================================================

export function upsertTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb().insert(schema.ticketSubscriptions).values({
        consumerId: consumer_id,
        ticketId: ticket_id,
        subscribedAt: nowIso(),
    }).onConflictDoNothing().run();
}

export function deleteTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb().delete(schema.ticketSubscriptions).where(and(
        eq(schema.ticketSubscriptions.consumerId, consumer_id),
        eq(schema.ticketSubscriptions.ticketId, ticket_id),
    )).run();
}

export function listTicketSubscribers(ticket_id: number): string[] {
    return getDb().select({ consumer_id: schema.ticketSubscriptions.consumerId })
        .from(schema.ticketSubscriptions)
        .where(eq(schema.ticketSubscriptions.ticketId, ticket_id))
        .all()
        .map((r) => r.consumer_id);
}

export function listTicketSubscriptions(consumer_id: string): {
    ticket_id: number;
    subscribed_at: string;
}[] {
    return getDb().select({
        ticket_id: schema.ticketSubscriptions.ticketId,
        subscribed_at: schema.ticketSubscriptions.subscribedAt,
    })
        .from(schema.ticketSubscriptions)
        .where(eq(schema.ticketSubscriptions.consumerId, consumer_id))
        .orderBy(desc(schema.ticketSubscriptions.subscribedAt))
        .all();
}
