import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";

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

/**
 * Closed-list initial tags. Created once, when the tags table is empty,
 * so the user has something to start with. The human can then add/edit/
 * remove freely from the UI.
 */
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

let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!db) {
        ensureDirs();
        db = new Database(DB_PATH);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        migrate(db);
    }
    return db;
}

function migrate(d: Database.Database): void {
    d.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            kind TEXT NOT NULL,
            ticket_id INTEGER,
            parent_id INTEGER,
            title TEXT,
            body TEXT,
            by_agent TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            decided_at TEXT,
            decided_by TEXT,
            matched_rule_id INTEGER,
            human_note TEXT,
            edited_title TEXT,
            edited_body TEXT,
            priority TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_status_project
            ON messages(status, project);
        CREATE INDEX IF NOT EXISTS idx_messages_kind_ticket
            ON messages(kind, ticket_id);
        CREATE INDEX IF NOT EXISTS idx_messages_parent
            ON messages(parent_id);

        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position INTEGER NOT NULL DEFAULT 0,
            match_project TEXT,
            match_kind TEXT,
            match_by_agent TEXT,
            decision TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            note TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rules_position
            ON rules(position) WHERE enabled = 1;

        CREATE TABLE IF NOT EXISTS subscriptions (
            consumer_id TEXT NOT NULL,
            project TEXT NOT NULL,
            subscribed_at TEXT NOT NULL,
            last_seen_id INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (consumer_id, project)
        );

        CREATE INDEX IF NOT EXISTS idx_subscriptions_project
            ON subscriptions(project);

        /*
         * Per-ticket subscriptions. Independent of project subscriptions:
         * an agent can follow a ticket they don't own, in a project they
         * don't subscribe to. Each subscriber's cursor lives in pings
         * (one row per delivered message), so consuming on one consumer
         * does not affect another.
         */
        CREATE TABLE IF NOT EXISTS ticket_subscriptions (
            consumer_id TEXT NOT NULL,
            ticket_id INTEGER NOT NULL,
            subscribed_at TEXT NOT NULL,
            PRIMARY KEY (consumer_id, ticket_id),
            FOREIGN KEY (ticket_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ticket_subs_ticket
            ON ticket_subscriptions(ticket_id);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        /*
         * Pings: lineage-based notifications. When a comment thread reaches a
         * ticket whose creator is a different agent than the commenter, we
         * insert a ping row so that creator can see the reply via /api/pings
         * even if they never subscribed to the project. seen_at = NULL means
         * unread.
         */
        CREATE TABLE IF NOT EXISTS pings (
            recipient TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            seen_at TEXT,
            PRIMARY KEY (recipient, message_id),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pings_recipient_unread
            ON pings(recipient) WHERE seen_at IS NULL;
    `);

    // Migration: add parent_id column to existing messages tables.
    const cols = d.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "parent_id")) {
        d.exec("ALTER TABLE messages ADD COLUMN parent_id INTEGER");
        d.exec("CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)");
    }
    if (!cols.some((c) => c.name === "priority")) {
        d.exec("ALTER TABLE messages ADD COLUMN priority TEXT");
    }

    // Migration: backfill pings for existing project subscriptions. The
    // delivery model switched from cursor (subscriptions.last_seen_id) to
    // per-message pings rows. Without this backfill, existing subscribers
    // would see an empty `unread()` even though they had messages waiting.
    // For each (consumer, project) sub, every approved message in that
    // project authored by someone else gets a ping inserted (idempotent
    // via the pings PK, so re-running is safe).
    const cursorMigrationDone = d
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("ping_backfill_v1") as { value: string } | undefined;
    if (!cursorMigrationDone) {
        d.exec(`
            INSERT OR IGNORE INTO pings (recipient, message_id, created_at)
            SELECT s.consumer_id, m.id, m.created_at
            FROM subscriptions s
            JOIN messages m ON m.project = s.project
            WHERE m.status = 'approved'
              AND (m.by_agent IS NULL OR m.by_agent != s.consumer_id)
              AND m.id > s.last_seen_id
        `);
        d.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
        ).run("ping_backfill_v1", new Date().toISOString());
    }

    // Tags (closed list, human-curated) + message ↔ tag join.
    d.exec(`
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tags_position ON tags(position);

        CREATE TABLE IF NOT EXISTS message_tags (
            message_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            set_at TEXT NOT NULL,
            set_by TEXT,
            PRIMARY KEY (message_id, tag_id),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_message_tags_tag ON message_tags(tag_id);
    `);

    const haveTags = (d.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n;
    if (haveTags === 0) {
        const ins = d.prepare(`
            INSERT INTO tags (name, color, position, note, created_at)
            VALUES (@name, @color, @position, @note, @created_at)
        `);
        const insertAll = d.transaction((rows: NewTag[]) => {
            const now = nowIso();
            for (const r of rows) {
                ins.run({
                    name: r.name,
                    color: r.color ?? null,
                    position: r.position ?? 0,
                    note: r.note ?? null,
                    created_at: now,
                });
            }
        });
        insertAll(DEFAULT_TAGS);
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

export function insertMessage(m: NewMessage): Message {
    const d = getDb();
    const stmt = d.prepare(`
        INSERT INTO messages
            (project, kind, ticket_id, parent_id, title, body, by_agent, priority, created_at)
        VALUES
            (@project, @kind, @ticket_id, @parent_id, @title, @body, @by_agent, @priority, @created_at)
        RETURNING *
    `);
    return stmt.get({
        project: m.project,
        kind: m.kind,
        ticket_id: m.ticket_id ?? null,
        parent_id: m.parent_id ?? null,
        title: m.title ?? null,
        body: m.body ?? null,
        by_agent: m.by_agent ?? null,
        priority: m.kind === "ticket_created" ? (m.priority ?? null) : null,
        created_at: nowIso(),
    }) as Message;
}

export function getMessage(id: number): Message | null {
    return (getDb()
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(id) as Message | undefined) ?? null;
}

export function listMessages(filters: {
    status?: MessageStatus;
    project?: string;
    kind?: MessageKind;
    by_agent?: string;
    limit?: number;
} = {}): Message[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.status) {
        where.push("status = @status");
        params.status = filters.status;
    }
    if (filters.project) {
        where.push("project = @project");
        params.project = filters.project;
    }
    if (filters.kind) {
        where.push("kind = @kind");
        params.kind = filters.kind;
    }
    if (filters.by_agent) {
        where.push("by_agent = @by_agent");
        params.by_agent = filters.by_agent;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = filters.limit ? `LIMIT ${Number(filters.limit) | 0}` : "";
    return getDb()
        .prepare(
            `SELECT * FROM messages ${whereSql} ORDER BY id DESC ${limitSql}`,
        )
        .all(params) as Message[];
}

export function updateMessageStatus(
    id: number,
    status: MessageStatus,
    decidedBy: "human" | "auto" | "owner",
    matchedRuleId: number | null = null,
): Message | null {
    getDb()
        .prepare(`
            UPDATE messages
            SET status = ?, decided_at = ?, decided_by = ?, matched_rule_id = ?
            WHERE id = ?
        `)
        .run(status, nowIso(), decidedBy, matchedRuleId, id);
    return getMessage(id);
}

export function editMessage(
    id: number,
    fields: { title?: string | null; body?: string | null },
): Message | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.title !== undefined) {
        sets.push("edited_title = ?");
        args.push(fields.title);
    }
    if (fields.body !== undefined) {
        sets.push("edited_body = ?");
        args.push(fields.body);
    }
    if (!sets.length) return getMessage(id);
    args.push(id);
    getDb()
        .prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`)
        .run(...args);
    return getMessage(id);
}

export function noteMessage(id: number, note: string | null): Message | null {
    getDb()
        .prepare("UPDATE messages SET human_note = ? WHERE id = ?")
        .run(note, id);
    return getMessage(id);
}

export function listProjects(): string[] {
    return (getDb()
        .prepare("SELECT DISTINCT project FROM messages ORDER BY project")
        .all() as { project: string }[]).map((r) => r.project);
}

export interface ProjectMeta {
    name: string;
    last_activity: string;
    ticket_count: number;
    comment_count: number;
    pending_count: number;
}

export function listProjectsDetailed(): ProjectMeta[] {
    return (getDb()
        .prepare(
            `SELECT
                project AS name,
                MAX(created_at) AS last_activity,
                SUM(CASE WHEN kind = 'ticket_created' THEN 1 ELSE 0 END) AS ticket_count,
                SUM(CASE WHEN kind = 'comment_added' THEN 1 ELSE 0 END) AS comment_count,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
             FROM messages
             GROUP BY project
             ORDER BY last_activity DESC`,
        )
        .all() as ProjectMeta[]).map((r) => ({
        name: r.name,
        last_activity: r.last_activity,
        ticket_count: Number(r.ticket_count),
        comment_count: Number(r.comment_count),
        pending_count: Number(r.pending_count),
    }));
}

/**
 * Hard-delete a project: every message in it (cascades to message_tags,
 * pings, ticket_subscriptions via FK), every project subscription. Returns
 * the count of deleted messages so the caller can decide whether to also
 * wipe the project's outbox file.
 */
export function deleteProject(name: string): { deleted_messages: number } {
    const d = getDb();
    const tx = d.transaction((p: string) => {
        const r = d.prepare("DELETE FROM messages WHERE project = ?").run(p);
        d.prepare("DELETE FROM subscriptions WHERE project = ?").run(p);
        return { deleted_messages: r.changes };
    });
    return tx(name);
}

export function insertRule(r: NewRule): Rule {
    const d = getDb();
    const stmt = d.prepare(`
        INSERT INTO rules
            (position, match_project, match_kind, match_by_agent,
             decision, enabled, note, created_at)
        VALUES (@position, @match_project, @match_kind, @match_by_agent,
                @decision, 1, @note, @created_at)
        RETURNING *
    `);
    return stmt.get({
        position: r.position ?? 0,
        match_project: r.match_project ?? null,
        match_kind: r.match_kind ?? null,
        match_by_agent: r.match_by_agent ?? null,
        decision: r.decision,
        note: r.note ?? null,
        created_at: nowIso(),
    }) as Rule;
}

export function listRules(opts: { enabledOnly?: boolean } = {}): Rule[] {
    const where = opts.enabledOnly ? "WHERE enabled = 1" : "";
    return getDb()
        .prepare(`SELECT * FROM rules ${where} ORDER BY position ASC, id ASC`)
        .all() as Rule[];
}

export function deleteRule(id: number): void {
    getDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
}

export function setRuleEnabled(id: number, enabled: boolean): Rule | null {
    getDb()
        .prepare("UPDATE rules SET enabled = ? WHERE id = ?")
        .run(enabled ? 1 : 0, id);
    return (getDb()
        .prepare("SELECT * FROM rules WHERE id = ?")
        .get(id) as Rule | undefined) ?? null;
}

// -------- subscriptions ----------------------------------------------------

export function upsertSubscription(
    consumer_id: string,
    project: string,
    catchup = false,
): Subscription {
    const d = getDb();
    const existing = d
        .prepare("SELECT * FROM subscriptions WHERE consumer_id=? AND project=?")
        .get(consumer_id, project) as Subscription | undefined;
    if (existing) return existing;

    // First time: optionally start at the current head so subscriber doesn't
    // receive backlog. catchup=true → start at 0 so they see all approved msgs.
    const head = catchup
        ? 0
        : ((d
            .prepare(
                "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE project=? AND status='approved'",
            )
            .get(project) as { m: number }).m);

    d.prepare(`
        INSERT INTO subscriptions (consumer_id, project, subscribed_at, last_seen_id)
        VALUES (?, ?, ?, ?)
    `).run(consumer_id, project, nowIso(), head);

    return d
        .prepare("SELECT * FROM subscriptions WHERE consumer_id=? AND project=?")
        .get(consumer_id, project) as Subscription;
}

export function deleteSubscription(consumer_id: string, project: string): void {
    getDb()
        .prepare("DELETE FROM subscriptions WHERE consumer_id=? AND project=?")
        .run(consumer_id, project);
}

export function listSubscriptions(consumer_id?: string): Subscription[] {
    if (consumer_id) {
        return getDb()
            .prepare("SELECT * FROM subscriptions WHERE consumer_id=? ORDER BY project")
            .all(consumer_id) as Subscription[];
    }
    return getDb()
        .prepare("SELECT * FROM subscriptions ORDER BY consumer_id, project")
        .all() as Subscription[];
}

/**
 * Project-feed delivery is now backed by the `pings` table, same as ticket
 * pings: one row per (consumer_id, message_id), per-message `seen_at`.
 * Pending-then-approved messages reach every subscriber correctly because
 * fan-out runs at approval time, not at submission. Compare to the older
 * cursor model (last_seen_id), which silently dropped messages whose status
 * flipped to approved AFTER the cursor advanced past their id.
 */
export function listUnread(
    consumer_id: string,
    project: string,
    limit = 100,
): Message[] {
    return getDb()
        .prepare(`
            SELECT m.* FROM pings p
            JOIN messages m ON m.id = p.message_id
            WHERE p.recipient = ? AND p.seen_at IS NULL AND m.project = ?
            ORDER BY m.id ASC
            LIMIT ?
        `)
        .all(consumer_id, project, limit) as Message[];
}

export function unreadCount(consumer_id: string, project: string): number {
    return (
        (getDb()
            .prepare(`
                SELECT COUNT(*) AS n FROM pings p
                JOIN messages m ON m.id = p.message_id
                WHERE p.recipient = ? AND p.seen_at IS NULL AND m.project = ?
            `)
            .get(consumer_id, project) as { n: number }).n
    );
}

export function listProjectSubscribers(project: string): string[] {
    return (getDb()
        .prepare("SELECT consumer_id FROM subscriptions WHERE project = ?")
        .all(project) as { consumer_id: string }[]).map((r) => r.consumer_id);
}

/**
 * Mark a single message as seen by this consumer. The new contract: an agent
 * acks the messages it actually received, one id at a time. There is no
 * "advance my cursor past a span of unseen messages" footgun anymore.
 */
export function markMessageSeen(
    consumer_id: string,
    message_id: number,
): { updated: number } {
    const r = getDb()
        .prepare(
            `UPDATE pings SET seen_at = ?
             WHERE recipient = ? AND message_id = ? AND seen_at IS NULL`,
        )
        .run(nowIso(), consumer_id, message_id);
    return { updated: r.changes };
}

/**
 * Bulk-ack helper: mark every currently-delivered-but-unseen ping for this
 * (consumer, project) pair as seen. Safe by construction — a ping only
 * exists once the message reached the recipient via fan-out, so this can
 * never ack content the consumer didn't receive (unlike the old cursor
 * `markAllRead` which jumped to project HEAD).
 *
 * Used by the human moderator's CLI (`aiball mark-read --all`). The MCP
 * tool surface for agents only exposes per-slice acks via the `mark_read`
 * flag on `unread`, never this function.
 */
export function markAllSeenForProject(
    consumer_id: string,
    project: string,
): { updated: number } {
    const r = getDb()
        .prepare(
            `UPDATE pings SET seen_at = ?
             WHERE recipient = ? AND seen_at IS NULL
             AND message_id IN (SELECT id FROM messages WHERE project = ?)`,
        )
        .run(nowIso(), consumer_id, project);
    return { updated: r.changes };
}

/**
 * Bulk-ack up to a given message id (CLI convenience). Safe under the
 * pings model: only acks rows that already exist in `pings` for this
 * recipient, so it can never invent a "seen" entry for content the
 * consumer didn't receive.
 */
export function markSeenUpToForProject(
    consumer_id: string,
    project: string,
    upToId: number,
): { updated: number } {
    const r = getDb()
        .prepare(
            `UPDATE pings SET seen_at = ?
             WHERE recipient = ? AND seen_at IS NULL AND message_id <= ?
             AND message_id IN (SELECT id FROM messages WHERE project = ?)`,
        )
        .run(nowIso(), consumer_id, upToId, project);
    return { updated: r.changes };
}

// -------- tags ------------------------------------------------------------

export function listTags(): Tag[] {
    return getDb()
        .prepare("SELECT * FROM tags ORDER BY position ASC, id ASC")
        .all() as Tag[];
}

export function getTag(id: number): Tag | null {
    return (getDb()
        .prepare("SELECT * FROM tags WHERE id = ?")
        .get(id) as Tag | undefined) ?? null;
}

export function getTagByName(name: string): Tag | null {
    return (getDb()
        .prepare("SELECT * FROM tags WHERE name = ?")
        .get(name) as Tag | undefined) ?? null;
}

export function insertTag(t: NewTag): Tag {
    return getDb()
        .prepare(`
            INSERT INTO tags (name, color, position, note, created_at)
            VALUES (@name, @color, @position, @note, @created_at)
            RETURNING *
        `)
        .get({
            name: t.name,
            color: t.color ?? null,
            position: t.position ?? 0,
            note: t.note ?? null,
            created_at: nowIso(),
        }) as Tag;
}

export function updateTag(
    id: number,
    fields: Partial<Pick<Tag, "name" | "color" | "position" | "note">>,
): Tag | null {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    for (const k of ["name", "color", "position", "note"] as const) {
        if (fields[k] !== undefined) {
            sets.push(`${k} = @${k}`);
            args[k] = fields[k];
        }
    }
    if (!sets.length) return getTag(id);
    getDb().prepare(`UPDATE tags SET ${sets.join(", ")} WHERE id = @id`).run(args);
    return getTag(id);
}

export function deleteTag(id: number): void {
    getDb().prepare("DELETE FROM tags WHERE id = ?").run(id);
}

export function listMessageTags(messageId: number): Tag[] {
    return getDb()
        .prepare(`
            SELECT t.* FROM tags t
            JOIN message_tags mt ON mt.tag_id = t.id
            WHERE mt.message_id = ?
            ORDER BY t.position ASC, t.id ASC
        `)
        .all(messageId) as Tag[];
}

/** Bulk-fetch tags for a list of message ids; returned as a Map<id, Tag[]>. */
export function tagsForMessages(messageIds: number[]): Map<number, Tag[]> {
    const out = new Map<number, Tag[]>();
    if (!messageIds.length) return out;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = getDb()
        .prepare(`
            SELECT mt.message_id, t.*
            FROM message_tags mt
            JOIN tags t ON t.id = mt.tag_id
            WHERE mt.message_id IN (${placeholders})
            ORDER BY t.position ASC, t.id ASC
        `)
        .all(...messageIds) as (Tag & { message_id: number })[];
    for (const r of rows) {
        const { message_id, ...tag } = r;
        if (!out.has(message_id)) out.set(message_id, []);
        out.get(message_id)!.push(tag as Tag);
    }
    return out;
}

export function addMessageTag(
    messageId: number,
    tagId: number,
    setBy: string | null = null,
): void {
    getDb()
        .prepare(`
            INSERT OR IGNORE INTO message_tags (message_id, tag_id, set_at, set_by)
            VALUES (?, ?, ?, ?)
        `)
        .run(messageId, tagId, nowIso(), setBy);
}

export function removeMessageTag(messageId: number, tagId: number): void {
    getDb()
        .prepare("DELETE FROM message_tags WHERE message_id = ? AND tag_id = ?")
        .run(messageId, tagId);
}

export function setMessageTags(
    messageId: number,
    tagIds: number[],
    setBy: string | null = null,
): void {
    const d = getDb();
    const tx = d.transaction((ids: number[]) => {
        d.prepare("DELETE FROM message_tags WHERE message_id = ?").run(messageId);
        const ins = d.prepare(`
            INSERT INTO message_tags (message_id, tag_id, set_at, set_by)
            VALUES (?, ?, ?, ?)
        `);
        const now = nowIso();
        for (const tid of ids) ins.run(messageId, tid, now, setBy);
    });
    tx([...new Set(tagIds)]);
}

// ---- settings (single-row k/v store) --------------------------------------

export function getSetting(key: string): string | null {
    const row = getDb()
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    getDb()
        .prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
}

export function getStrategy(): Strategy {
    const v = getSetting("strategy");
    if (v && (STRATEGIES as readonly string[]).includes(v)) return v as Strategy;
    return DEFAULT_STRATEGY;
}

export function setStrategy(s: Strategy): void {
    setSetting("strategy", s);
}

// ---- pings ----------------------------------------------------------------

export function insertPing(recipient: string, messageId: number): void {
    getDb()
        .prepare(
            "INSERT OR IGNORE INTO pings (recipient, message_id, created_at) VALUES (?, ?, ?)",
        )
        .run(recipient, messageId, nowIso());
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
    const where = ["p.recipient = @recipient"];
    if (opts.unreadOnly) where.push("p.seen_at IS NULL");
    const lim = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : "";
    const rows = getDb()
        .prepare(
            `SELECT p.recipient AS p_recipient,
                    p.message_id AS p_message_id,
                    p.created_at AS p_created_at,
                    p.seen_at AS p_seen_at,
                    m.*
             FROM pings p JOIN messages m ON m.id = p.message_id
             WHERE ${where.join(" AND ")}
             ORDER BY p.created_at DESC
             ${lim}`,
        )
        .all({ recipient: opts.recipient }) as Record<string, unknown>[];
    return rows.map((row) => ({
        recipient: row.p_recipient as string,
        message_id: row.p_message_id as number,
        created_at: row.p_created_at as string,
        seen_at: (row.p_seen_at as string | null) ?? null,
        message: {
            id: row.id as number,
            project: row.project as string,
            kind: row.kind as MessageKind,
            ticket_id: (row.ticket_id as number | null) ?? null,
            parent_id: (row.parent_id as number | null) ?? null,
            title: (row.title as string | null) ?? null,
            body: (row.body as string | null) ?? null,
            by_agent: (row.by_agent as string | null) ?? null,
            status: row.status as MessageStatus,
            created_at: row.created_at as string,
            decided_at: (row.decided_at as string | null) ?? null,
            decided_by: (row.decided_by as string | null) ?? null,
            matched_rule_id: (row.matched_rule_id as number | null) ?? null,
            human_note: (row.human_note as string | null) ?? null,
            edited_title: (row.edited_title as string | null) ?? null,
            edited_body: (row.edited_body as string | null) ?? null,
            priority: (row.priority as Priority | null) ?? null,
        },
    }));
}

export function markPingsRead(opts: {
    recipient: string;
    upToId?: number;
    all?: boolean;
}): { updated: number } {
    if (!opts.upToId && !opts.all) return { updated: 0 };
    const now = nowIso();
    const where = ["recipient = @recipient", "seen_at IS NULL"];
    if (opts.upToId) where.push("message_id <= @upToId");
    const r = getDb()
        .prepare(
            `UPDATE pings SET seen_at = @now WHERE ${where.join(" AND ")}`,
        )
        .run({
            recipient: opts.recipient,
            upToId: opts.upToId ?? null,
            now,
        });
    return { updated: r.changes };
}

export function unreadPingCount(recipient: string): number {
    return (
        (getDb()
            .prepare(
                "SELECT COUNT(*) AS n FROM pings WHERE recipient = ? AND seen_at IS NULL",
            )
            .get(recipient) as { n: number }).n
    );
}

// ---- ticket subscriptions -------------------------------------------------

export function upsertTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb()
        .prepare(
            `INSERT INTO ticket_subscriptions (consumer_id, ticket_id, subscribed_at)
             VALUES (?, ?, ?)
             ON CONFLICT(consumer_id, ticket_id) DO NOTHING`,
        )
        .run(consumer_id, ticket_id, nowIso());
}

export function deleteTicketSubscription(
    consumer_id: string,
    ticket_id: number,
): void {
    getDb()
        .prepare(
            "DELETE FROM ticket_subscriptions WHERE consumer_id = ? AND ticket_id = ?",
        )
        .run(consumer_id, ticket_id);
}

export function listTicketSubscribers(ticket_id: number): string[] {
    return (getDb()
        .prepare(
            "SELECT consumer_id FROM ticket_subscriptions WHERE ticket_id = ?",
        )
        .all(ticket_id) as { consumer_id: string }[]).map((r) => r.consumer_id);
}

export function listTicketSubscriptions(consumer_id: string): {
    ticket_id: number;
    subscribed_at: string;
}[] {
    return getDb()
        .prepare(
            "SELECT ticket_id, subscribed_at FROM ticket_subscriptions WHERE consumer_id = ? ORDER BY subscribed_at DESC",
        )
        .all(consumer_id) as { ticket_id: number; subscribed_at: string }[];
}
