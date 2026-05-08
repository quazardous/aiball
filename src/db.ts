import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as schema from "./schema.js";
import { DB_PATH, ensureDirs } from "./paths.js";

// =====================================================================
// Public types — re-exported / aliased so consumers (api.ts, mcp.ts, …)
// don't import from drizzle directly.
// =====================================================================

export type MessageKind =
    | "ticket_created"
    | "comment_added"
    | "ticket_closed"
    | "ticket_reopened";
export type MessageStatus = "pending" | "approved" | "rejected";
export type RuleDecision = "auto" | "review";
export type Priority = "panic" | "request" | "question" | "fyi";
export const PRIORITIES: readonly Priority[] = ["panic", "request", "question", "fyi"];

export type Strategy = "manual" | "auto" | "auto-reply";
export const STRATEGIES: readonly Strategy[] = ["manual", "auto", "auto-reply"];
export const DEFAULT_STRATEGY: Strategy = "auto-reply";

/** Drizzle row types (internal) re-exported for callers that handle the
 *  split shapes natively. The legacy union JSON shape is `Message` below. */
export type TicketRow = schema.Ticket;
export type MessageRow = schema.Message;

/**
 * Legacy union shape for JSON output. Tickets project as kind=ticket_created
 * with title/priority populated and ticket_id/parent_id null; non-tickets
 * carry ticket_id (always set), parent_id (= parent_message_id, defaulting
 * to ticket_id for top-level), and inherit project from their parent ticket.
 * This is the on-the-wire contract with api.ts and the frontend; the DB
 * itself stores the two shapes in separate physical tables.
 */
export interface Message {
    id: number;
    project: string;
    kind: MessageKind;
    ticket_id: number | null;
    parent_id: number | null;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    status: MessageStatus;
    created_at: string;
    decided_at: string | null;
    decided_by: string | null;
    matched_rule_id: number | null;
    human_note: string | null;
    edited_title: string | null;
    edited_body: string | null;
    priority: Priority | null;
    display_seq: number;
}

export interface Subscription {
    consumer_id: string;
    project: string;
    subscribed_at: string;
    last_seen_id: number;
}

export interface Rule {
    id: number;
    position: number;
    match_project: string | null;
    match_kind: MessageKind | null;
    match_by_agent: string | null;
    decision: RuleDecision;
    enabled: number;
    note: string | null;
    created_at: string;
}

export interface NewMessage {
    project: string;
    kind: MessageKind;
    ticket_id?: number | null;
    parent_id?: number | null;
    title?: string | null;
    body?: string | null;
    by_agent?: string | null;
    priority?: Priority | null;
}

export interface NewRule {
    position?: number;
    match_project?: string | null;
    match_kind?: MessageKind | null;
    match_by_agent?: string | null;
    decision: RuleDecision;
    note?: string | null;
}

export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

export interface NewTag {
    name: string;
    color?: string | null;
    note?: string | null;
    position?: number;
}

/** Closed-list initial tags. Created once, when the tags table is empty. */
const DEFAULT_TAGS: NewTag[] = [
    { name: "bug", color: "#ef4444", note: "something is broken", position: 1 },
    { name: "feature", color: "#10b981", note: "new capability", position: 2 },
    { name: "question", color: "#3b82f6", note: "needs clarification", position: 3 },
    { name: "docs", color: "#8b5cf6", note: "documentation work", position: 4 },
    { name: "urgent", color: "#f59e0b", note: "needs attention now", position: 5 },
    { name: "discussion", color: "#6b7280", note: "design / architecture talk", position: 6 },
    { name: "wontfix", color: "#9ca3af", note: "decided not to act", position: 7 },
    { name: "done", color: "#22c55e", note: "completed", position: 8 },
];

// =====================================================================
// Connection + migrations (Drizzle drives the schema).
// =====================================================================

let sqlite: Database.Database | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;

function migrationsFolder(): string {
    // db.ts compiles/runs from src/ at dev time (tsx) or dist/ if built.
    // The drizzle/ folder lives at the repo root, two levels up from src/.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(here, "..", "drizzle", "migrations"),
        resolve(here, "..", "..", "drizzle", "migrations"),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return candidates[0];
}

export function getDb(): BetterSQLite3Database<typeof schema> {
    if (!dbInstance) {
        ensureDirs();
        sqlite = new Database(DB_PATH);
        sqlite.pragma("journal_mode = WAL");
        sqlite.pragma("foreign_keys = ON");
        dbInstance = drizzle(sqlite, { schema });
        migrate(dbInstance, { migrationsFolder: migrationsFolder() });
        bootstrap(dbInstance);
    }
    return dbInstance;
}

function bootstrap(db: BetterSQLite3Database<typeof schema>): void {
    // Ensure the global id counter exists (idempotent).
    db.insert(schema.settings)
        .values({ key: "next_global_id", value: "1" })
        .onConflictDoNothing()
        .run();

    // Seed the closed-list tag catalog on a fresh DB.
    const haveTags = db.select({ n: sql<number>`COUNT(*)` }).from(schema.tags).get();
    if ((haveTags?.n ?? 0) === 0) {
        const now = nowIso();
        for (const t of DEFAULT_TAGS) {
            db.insert(schema.tags).values({
                name: t.name,
                color: t.color ?? null,
                position: t.position ?? 0,
                note: t.note ?? null,
                createdAt: now,
            }).run();
        }
    }
}

// =====================================================================
// Helpers
// =====================================================================

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Allocate the next id from the shared counter so tickets and _messages stay
 * in a single id space (pings reference this single integer namespace).
 * Must be called inside an active transaction for atomicity.
 */
function nextGlobalId(db: BetterSQLite3Database<typeof schema>): number {
    const row = db.select().from(schema.settings)
        .where(eq(schema.settings.key, "next_global_id"))
        .get();
    const current = row ? Number(row.value) : 1;
    db.insert(schema.settings)
        .values({ key: "next_global_id", value: String(current + 1) })
        .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: String(current + 1) },
        })
        .run();
    return current;
}

function ticketRowToMessage(t: schema.Ticket): Message {
    return {
        id: t.id,
        project: t.project,
        kind: "ticket_created",
        ticket_id: null,
        parent_id: null,
        title: t.title,
        body: t.body,
        by_agent: t.byAgent,
        status: t.status as MessageStatus,
        created_at: t.createdAt,
        decided_at: t.decidedAt,
        decided_by: t.decidedBy,
        matched_rule_id: t.matchedRuleId,
        human_note: t.humanNote,
        edited_title: t.editedTitle,
        edited_body: t.editedBody,
        priority: (t.priority as Priority | null) ?? null,
        display_seq: t.displaySeq,
    };
}

function messageRowToMessage(m: schema.Message, project: string): Message {
    return {
        id: m.id,
        project,
        kind: m.kind as MessageKind,
        ticket_id: m.ticketId,
        // Legacy callers expect parent_id == ticket_id for top-level replies;
        // the new schema stores NULL for that case.
        parent_id: m.parentMessageId ?? m.ticketId,
        title: null,
        body: m.body,
        by_agent: m.byAgent,
        status: m.status as MessageStatus,
        created_at: m.createdAt,
        decided_at: m.decidedAt,
        decided_by: m.decidedBy,
        matched_rule_id: m.matchedRuleId,
        human_note: m.humanNote,
        edited_title: null,
        edited_body: m.editedBody,
        priority: null,
        display_seq: m.displaySeq,
    };
}

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
                priority: m.priority ?? null,
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
        const inserted = tx.insert(schema.messages).values({
            id,
            ticketId: m.ticket_id,
            displaySeq: seq,
            kind: m.kind,
            parentMessageId,
            body: m.body ?? null,
            byAgent: m.by_agent ?? null,
            createdAt,
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
    fields: { title?: string | null; body?: string | null },
): Message | null {
    const db = getDb();
    // Try tickets first (only tickets have edited_title).
    const ticketPatch: Partial<schema.NewTicket> = {};
    if (fields.title !== undefined) ticketPatch.editedTitle = fields.title;
    if (fields.body !== undefined) ticketPatch.editedBody = fields.body;
    if (Object.keys(ticketPatch).length > 0) {
        const t = db.update(schema.tickets)
            .set(ticketPatch)
            .where(eq(schema.tickets.id, id))
            .run();
        if (t.changes > 0) return getMessage(id);
    }
    // Otherwise try messages — body only (no edited_title).
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

    const messageAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.messages.createdAt})`,
        comment_count: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' THEN 1 ELSE 0 END)`,
        message_pending: sql<number>`SUM(CASE WHEN ${schema.messages.status} = 'pending' THEN 1 ELSE 0 END)`,
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
    if (consumer_id) {
        // Per-project unread for this consumer = pings (ticket OR message)
        // joined to tickets to get the project. One query per source, merged.
        const ticketUnread = db.select({
            project: schema.tickets.project,
            n: sql<number>`COUNT(*)`,
        })
            .from(schema.pings)
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
            ))
            .groupBy(schema.tickets.project)
            .all();
        const messageUnread = db.select({
            project: schema.tickets.project,
            n: sql<number>`COUNT(*)`,
        })
            .from(schema.pings)
            .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
            ))
            .groupBy(schema.tickets.project)
            .all();
        const counts = new Map<string, number>();
        for (const r of ticketUnread) counts.set(r.project, (counts.get(r.project) ?? 0) + Number(r.n));
        for (const r of messageUnread) counts.set(r.project, (counts.get(r.project) ?? 0) + Number(r.n));
        for (const p of byProject.values()) {
            p.unread_for_consumer = counts.get(p.name) ?? 0;
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

export function upsertSubscription(
    consumer_id: string,
    project: string,
    _catchup = false,
): Subscription {
    const db = getDb();
    const existing = db.select().from(schema.subscriptions)
        .where(and(
            eq(schema.subscriptions.consumerId, consumer_id),
            eq(schema.subscriptions.project, project),
        )).get();
    if (existing) {
        return {
            consumer_id: existing.consumerId,
            project: existing.project,
            subscribed_at: existing.subscribedAt,
            last_seen_id: existing.lastSeenId,
        };
    }
    db.insert(schema.subscriptions).values({
        consumerId: consumer_id,
        project,
        subscribedAt: nowIso(),
        lastSeenId: 0, // dormant, kept for column compat
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
        }));
}

export function listProjectSubscribers(project: string): string[] {
    return getDb()
        .select({ consumer_id: schema.subscriptions.consumerId })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.project, project))
        .all()
        .map((r) => r.consumer_id);
}

// =====================================================================
// Inbox / unread (backed by pings, joined with messages or tickets)
// =====================================================================

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
        ))
        .all();

    const merged: Message[] = [
        ...ticketHits.map((r) => ticketRowToMessage(r.t)),
        ...messageHits.map((r) => messageRowToMessage(r.m, r.project)),
    ].sort((a, b) => a.id - b.id);

    return merged.slice(0, limit);
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
        )).get();
    const m = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, project),
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
    const conds = [eq(schema.pings.recipient, opts.recipient)];
    if (opts.unreadOnly) conds.push(isNull(schema.pings.seenAt));

    const ticketHits = db.select({ ping: schema.pings, t: schema.tickets })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
        .where(and(...conds))
        .all();

    const messageHits = db.select({
        ping: schema.pings,
        m: schema.messages,
        project: schema.tickets.project,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(...conds))
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
    const r = getDb().select({ n: sql<number>`COUNT(*)` })
        .from(schema.pings)
        .where(and(
            eq(schema.pings.recipient, recipient),
            isNull(schema.pings.seenAt),
        )).get();
    return Number(r?.n ?? 0);
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

// =====================================================================
// Tags + ticket_tags (tags are ticket-scoped only)
// =====================================================================

function tagRowToTag(t: schema.Tag): Tag {
    return {
        id: t.id,
        name: t.name,
        color: t.color,
        position: t.position,
        note: t.note,
        created_at: t.createdAt,
    };
}

export function listTags(): Tag[] {
    return getDb().select().from(schema.tags)
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all().map(tagRowToTag);
}

export function getTag(id: number): Tag | null {
    const r = getDb().select().from(schema.tags).where(eq(schema.tags.id, id)).get();
    return r ? tagRowToTag(r) : null;
}

export function getTagByName(name: string): Tag | null {
    const r = getDb().select().from(schema.tags).where(eq(schema.tags.name, name)).get();
    return r ? tagRowToTag(r) : null;
}

export function insertTag(t: NewTag): Tag {
    const r = getDb().insert(schema.tags).values({
        name: t.name,
        color: t.color ?? null,
        position: t.position ?? 0,
        note: t.note ?? null,
        createdAt: nowIso(),
    }).returning().get();
    return tagRowToTag(r);
}

export function updateTag(
    id: number,
    fields: Partial<Pick<Tag, "name" | "color" | "position" | "note">>,
): Tag | null {
    const patch: Partial<schema.NewTagRow> = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.color !== undefined) patch.color = fields.color;
    if (fields.position !== undefined) patch.position = fields.position;
    if (fields.note !== undefined) patch.note = fields.note;
    if (Object.keys(patch).length === 0) return getTag(id);
    getDb().update(schema.tags).set(patch).where(eq(schema.tags.id, id)).run();
    return getTag(id);
}

export function deleteTag(id: number): void {
    getDb().delete(schema.tags).where(eq(schema.tags.id, id)).run();
}

/**
 * Tag operations work on ticket ids only (tags are ticket-scoped).
 * Function names keep the historical `Message` suffix for caller compat.
 */
export function listMessageTags(messageId: number): Tag[] {
    return getDb().select({ t: schema.tags })
        .from(schema.ticketTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.ticketTags.tagId))
        .where(eq(schema.ticketTags.ticketId, messageId))
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all()
        .map((r) => tagRowToTag(r.t));
}

export function tagsForMessages(messageIds: number[]): Map<number, Tag[]> {
    const out = new Map<number, Tag[]>();
    if (!messageIds.length) return out;
    const rows = getDb().select({ t: schema.tags, ticketId: schema.ticketTags.ticketId })
        .from(schema.ticketTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.ticketTags.tagId))
        .where(inArray(schema.ticketTags.ticketId, messageIds))
        .orderBy(asc(schema.tags.position), asc(schema.tags.id))
        .all();
    for (const r of rows) {
        if (!out.has(r.ticketId)) out.set(r.ticketId, []);
        out.get(r.ticketId)!.push(tagRowToTag(r.t));
    }
    return out;
}

export function addMessageTag(
    messageId: number,
    tagId: number,
    setBy: string | null = null,
): void {
    getDb().insert(schema.ticketTags).values({
        ticketId: messageId,
        tagId,
        setAt: nowIso(),
        setBy,
    }).onConflictDoNothing().run();
}

export function removeMessageTag(messageId: number, tagId: number): void {
    getDb().delete(schema.ticketTags).where(and(
        eq(schema.ticketTags.ticketId, messageId),
        eq(schema.ticketTags.tagId, tagId),
    )).run();
}

export function setMessageTags(
    messageId: number,
    tagIds: number[],
    setBy: string | null = null,
): void {
    const db = getDb();
    db.transaction((tx) => {
        tx.delete(schema.ticketTags).where(eq(schema.ticketTags.ticketId, messageId)).run();
        const now = nowIso();
        for (const tagId of [...new Set(tagIds)]) {
            tx.insert(schema.ticketTags).values({
                ticketId: messageId,
                tagId,
                setAt: now,
                setBy,
            }).run();
        }
    });
}

// =====================================================================
// Settings (k/v) + Strategy
// =====================================================================

export function getSetting(key: string): string | null {
    const r = getDb().select({ value: schema.settings.value })
        .from(schema.settings).where(eq(schema.settings.key, key)).get();
    return r?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    getDb().insert(schema.settings).values({ key, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .run();
}

export function getStrategy(): Strategy {
    const v = getSetting("strategy");
    if (v && (STRATEGIES as readonly string[]).includes(v)) return v as Strategy;
    return DEFAULT_STRATEGY;
}

export function setStrategy(s: Strategy): void {
    setSetting("strategy", s);
}
