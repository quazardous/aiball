/**
 * SQLite + Drizzle connection plumbing — opens the DB, runs migrations,
 * seeds the closed-list tags + the global id counter, and exposes a
 * handful of low-level helpers (id allocator, hashid generator, time
 * formatter, row-to-public-shape converters) used by every domain
 * module under `src/db/`.
 *
 * Extracted from db.ts (#B.332 Phase A).
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, isNull, or, sql } from "drizzle-orm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as schema from "../schema.js";
import { DB_PATH, ensureDirs } from "../paths.js";
import { DEFAULT_TAGS } from "./tags.js";

// =====================================================================
// Public types — re-exported from db.ts so consumers don't dig into
// drizzle directly. Kept here (rather than in their own types.ts) so
// connection.ts is the single low-level dependency.
// =====================================================================

// Domain enums live in `src/domain.ts` (#B.122). Imported locally so
// uses inside this file resolve, then re-exported so existing call
// sites importing from db.ts keep compiling without touching imports.
import {
    MESSAGE_KINDS,
    MESSAGE_STATUSES,
    RULE_DECISIONS,
    INTENTS,
    PRIORITIES,
    STRATEGIES,
    isMessageKind,
    isMessageStatus,
    isIntent,
    isPriority,
    isStrategy,
} from "../domain.js";
import type {
    MessageKind,
    MessageStatus,
    RuleDecision,
    Intent,
    Priority,
    Strategy,
} from "../domain.js";
export {
    MESSAGE_KINDS,
    MESSAGE_STATUSES,
    RULE_DECISIONS,
    INTENTS,
    PRIORITIES,
    STRATEGIES,
    isMessageKind,
    isMessageStatus,
    isIntent,
    isPriority,
    isStrategy,
};
export type { MessageKind, MessageStatus, RuleDecision, Intent, Priority, Strategy };

/** Drizzle row types (internal) re-exported for callers that handle the
 *  split shapes natively. The legacy union JSON shape is `Message` below. */
export type TicketRow = schema.Ticket;
export type MessageRow = schema.Message;

/**
 * Legacy union shape for JSON output. Tickets project as kind=ticket_created
 * with title/intent populated and ticket_id/parent_id null; non-tickets
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
    /**
     * Agent-authored short summary (tickets only, #B.87). Optional. NULL
     * for non-ticket rows and for tickets posted before this column
     * existed. Consumers usually fall back to `title` when absent.
     */
    summary?: string | null;
    by_agent: string | null;
    status: MessageStatus;
    created_at: string;
    decided_at: string | null;
    decided_by: string | null;
    matched_rule_id: number | null;
    human_note: string | null;
    edited_title: string | null;
    edited_body: string | null;
    intent: Intent | null;
    /**
     * Urgency hint (#B.222) — tickets only, always set (DB default
     * 'normal'). NULL on the wire only for non-ticket rows where it
     * doesn't apply. Read by listMessages / poll / listPings sorts.
     */
    priority?: Priority;
    display_seq: number;
    /**
     * Event scope (#B.245 tristate). One of `internal` / `default` /
     * `broadcast`. Drives `fanOutPings` granularity per-event:
     *
     *   internal  → owners only + @mentions (no ticket subscribers,
     *               no followers; @projet narrows to owners-only)
     *   default   → ticket subscribers + project owners + @mentions
     *   broadcast → default + project followers
     *
     * Carried on every row (tickets + _messages), since every event
     * decides its own fan-out independently.
     */
    scope: "internal" | "default" | "broadcast";
    /**
     * Public-facing alphanumeric ref for comments and lifecycle events
     * (#C<hashid>). NULL for tickets (which use their integer id directly
     * as `#B<id>`). 6 chars from a Crockford-ish base32 alphabet, randomly
     * chosen at insert time to never collide with ticket numbers.
     */
    hashid: string | null;
    /**
     * Snooze / postpone timestamp (per #B.329). When set to an ISO8601
     * date in the future, the ticket is hidden from the open inbox until
     * the daemon's reveal cron clears the field. NULL for non-ticket
     * rows and for tickets that aren't currently snoozed.
     */
    postponed_until?: string | null;
    /**
     * Set when this ticket is a sub-ticket of another ticket. NULL for
     * non-ticket rows and for top-level tickets.
     */
    parent_ticket_id?: number | null;
    /**
     * Set on `ticket_sub_added` and `ticket_referenced` pseudo-comments:
     * points at the source ticket that triggered the relation (the child
     * for sub_added; the mentioning ticket for referenced). NULL on any
     * other kind. Lets the UI render a clickable link without parsing
     * the body.
     */
    source_ticket_id?: number | null;
    /**
     * Sidecar JSON metadata (#B.104). String-encoded JSON shaped like
     * `{"questions": {"q-abc": {answered_by, answered_at, answered_in}}}`.
     * NULL when no metadata is attached. Today only used for the
     * question-answer audit; future fields (signatures, polls, ...)
     * colocate without schema changes.
     */
    meta?: string | null;
}

export type SubscriptionRole = "owner" | "follower";

export interface Subscription {
    consumer_id: string;
    project: string;
    subscribed_at: string;
    last_seen_id: number;
    role: SubscriptionRole;
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
    /** Tickets only — optional agent-authored short summary (#B.87). */
    summary?: string | null;
    by_agent?: string | null;
    intent?: Intent | null;
    /** #B.222 urgency hint — tickets only. Defaults to 'normal' at the
     *  SQL layer if omitted. Ignored for non-ticket kinds. */
    priority?: Priority | null;
    /** #B.129 decision-on-comment: author tags a comment as decisional
     *  at post-time (`plan` / `resolution` / extensible). Stored in
     *  `meta.decision = {kind, status:"pending"}` so the reporter can
     *  later accept/reject via POST /api/messages/:id/decide. */
    decision_kind?: string | null;
    /** #B.130 phase 1: author-supplied one-line TLDR. comment_added
     *  only — used by brief-mode reads to skip the full body. */
    summary_until?: string | null;
    /** #B.245 tristate scope. `internal` = owners only + @mentions;
     *  `default` = subs + owners + @mentions; `broadcast` = +
     *  followers. Applies to every kind (ticket_created uses it the
     *  same way comments do). When absent the column default
     *  `'default'` applies. */
    scope?: "internal" | "default" | "broadcast";
}

export interface NewRule {
    position?: number;
    match_project?: string | null;
    match_kind?: MessageKind | null;
    match_by_agent?: string | null;
    decision: RuleDecision;
    note?: string | null;
}

// =====================================================================
// Connection + migrations (Drizzle drives the schema).
// =====================================================================

let sqlite: Database.Database | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;

function migrationsFolder(): string {
    // db.ts compiles/runs from src/ at dev time (tsx) or dist/ if built.
    // The drizzle/ folder lives at the repo root, two levels up from src/.
    // src/db/connection.ts adds another level, hence the extra ".." candidate.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(here, "..", "drizzle", "migrations"),
        resolve(here, "..", "..", "drizzle", "migrations"),
        resolve(here, "..", "..", "..", "drizzle", "migrations"),
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

/**
 * Raw better-sqlite3 handle. Exposed for modules that need to issue
 * prepared statements bypassing Drizzle — currently only the FTS5
 * search service in `search.ts`, which talks to virtual tables and
 * uses SQLite-specific functions (`snippet()`, `MATCH`, `rank`) that
 * Drizzle has no first-class binding for.
 */
export function getRawSqlite(): Database.Database {
    if (!sqlite) {
        // Force initialization via getDb to run migrations / bootstrap.
        getDb();
    }
    if (!sqlite) throw new Error("sqlite handle not initialized after getDb()");
    return sqlite;
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

    // Backfill hashids for any pre-0003 _messages row that doesn't have one.
    // Idempotent: rows that already have a hashid are skipped. Generates
    // and persists in a single pass; collisions are vanishingly rare with
    // 31^6 ≈ 8.8e8 keyspace.
    const missing = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(or(isNull(schema.messages.hashid), eq(schema.messages.hashid, "")))
        .all();
    for (const row of missing) {
        const hashid = pickFreshHashid(db);
        db.update(schema.messages)
            .set({ hashid })
            .where(eq(schema.messages.id, row.id))
            .run();
    }
}

/**
 * Public-facing comment reference. 6 chars from a 31-char Crockford-ish
 * alphabet (no `i`, `l`, `o`, `0`, `1` to avoid confusion). Random, not
 * derived from internal id — that way the hashid leaks no ordering and
 * stays stable across renumbering operations.
 */
const HASHID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const HASHID_LENGTH = 6;
export function generateHashid(): string {
    const buf = randomBytes(8);
    let out = "";
    for (let i = 0; i < HASHID_LENGTH; i++) {
        out += HASHID_ALPHABET[buf[i] % HASHID_ALPHABET.length];
    }
    return out;
}
export function pickFreshHashid(db: BetterSQLite3Database<typeof schema>): string {
    for (let attempts = 0; attempts < 8; attempts++) {
        const candidate = generateHashid();
        const clash = db.select({ id: schema.messages.id })
            .from(schema.messages)
            .where(eq(schema.messages.hashid, candidate))
            .get();
        if (!clash) return candidate;
    }
    // Shouldn't happen with 8.8e8 keyspace and a few tens of millions of
    // rows, but if we somehow keep colliding throw rather than corrupt.
    throw new Error("could not allocate a unique hashid after 8 attempts");
}

// =====================================================================
// Small helpers used across domains
// =====================================================================

export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Allocate the next ticket id. Tickets keep their own dense counter so the
 * user-facing `#B.NNN` series stays sequential — no longer shared with the
 * comment id space (see migration 0007 which split pings into ticket_id +
 * comment_id columns and dropped the global counter).
 *
 * Must be called inside an active transaction for atomicity.
 */
export function nextTicketId(db: BetterSQLite3Database<typeof schema>): number {
    return allocateCounter(db, "next_ticket_id");
}

/**
 * Allocate the next comment / lifecycle-event id. Distinct counter from
 * tickets; the two spaces are no longer shared because pings now has
 * explicit ticket_id / comment_id columns instead of a polymorphic
 * message_id.
 */
export function nextMessageId(db: BetterSQLite3Database<typeof schema>): number {
    return allocateCounter(db, "next_message_id");
}

function allocateCounter(
    db: BetterSQLite3Database<typeof schema>,
    key: string,
): number {
    const row = db.select().from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
    const current = row ? Number(row.value) : 1;
    db.insert(schema.settings)
        .values({ key, value: String(current + 1) })
        .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: String(current + 1) },
        })
        .run();
    return current;
}

export function ticketRowToMessage(t: schema.Ticket): Message {
    return {
        id: t.id,
        project: t.project,
        kind: "ticket_created",
        ticket_id: null,
        parent_id: null,
        title: t.title,
        body: t.body,
        summary: t.summary ?? null,
        by_agent: t.byAgent,
        status: t.status as MessageStatus,
        created_at: t.createdAt,
        decided_at: t.decidedAt,
        decided_by: t.decidedBy,
        matched_rule_id: t.matchedRuleId,
        human_note: t.humanNote,
        edited_title: t.editedTitle,
        edited_body: t.editedBody,
        intent: (t.intent as Intent | null) ?? null,
        priority: (t.priority as Priority | undefined) ?? "normal",
        display_seq: t.displaySeq,
        scope: ((t.scope as "internal" | "default" | "broadcast" | undefined) ?? "default"),
        hashid: null,
        postponed_until: t.postponedUntil ?? null,
        parent_ticket_id: t.parentTicketId ?? null,
        source_ticket_id: null,
        meta: t.meta ?? null,
    };
}

export function messageRowToMessage(m: schema.Message, project: string): Message {
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
        intent: null,
        display_seq: m.displaySeq,
        scope: ((m.scope as "internal" | "default" | "broadcast" | undefined) ?? "default"),
        hashid: m.hashid ?? null,
        source_ticket_id: m.sourceTicketId ?? null,
        meta: m.meta ?? null,
    };
}
