import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";

export type MessageKind = "ticket_created" | "comment_added" | "ticket_closed";
export type MessageStatus = "pending" | "approved" | "rejected";
export type RuleDecision = "auto" | "review";

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
}

export interface NewRule {
    position?: number;
    match_project?: string | null;
    match_kind?: MessageKind | null;
    match_by_agent?: string | null;
    decision: RuleDecision;
    note?: string | null;
}

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
            edited_body TEXT
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
    `);

    // Migration: add parent_id column to existing messages tables.
    const cols = d.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "parent_id")) {
        d.exec("ALTER TABLE messages ADD COLUMN parent_id INTEGER");
        d.exec("CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)");
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

export function insertMessage(m: NewMessage): Message {
    const d = getDb();
    const stmt = d.prepare(`
        INSERT INTO messages
            (project, kind, ticket_id, parent_id, title, body, by_agent, created_at)
        VALUES
            (@project, @kind, @ticket_id, @parent_id, @title, @body, @by_agent, @created_at)
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
    decidedBy: "human" | "auto",
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

export function listUnread(
    consumer_id: string,
    project: string,
    limit = 100,
): Message[] {
    const sub = getDb()
        .prepare("SELECT last_seen_id FROM subscriptions WHERE consumer_id=? AND project=?")
        .get(consumer_id, project) as { last_seen_id: number } | undefined;
    const lastSeen = sub?.last_seen_id ?? 0;
    return getDb()
        .prepare(`
            SELECT * FROM messages
            WHERE project = ? AND status = 'approved' AND id > ?
            ORDER BY id ASC
            LIMIT ?
        `)
        .all(project, lastSeen, limit) as Message[];
}

export function unreadCount(consumer_id: string, project: string): number {
    const sub = getDb()
        .prepare("SELECT last_seen_id FROM subscriptions WHERE consumer_id=? AND project=?")
        .get(consumer_id, project) as { last_seen_id: number } | undefined;
    const lastSeen = sub?.last_seen_id ?? 0;
    const r = getDb()
        .prepare(`
            SELECT COUNT(*) AS n FROM messages
            WHERE project=? AND status='approved' AND id > ?
        `)
        .get(project, lastSeen) as { n: number };
    return r.n;
}

export function markRead(
    consumer_id: string,
    project: string,
    upToId: number,
): Subscription | null {
    // Don't move backwards
    getDb()
        .prepare(`
            UPDATE subscriptions
            SET last_seen_id = ?
            WHERE consumer_id=? AND project=? AND last_seen_id < ?
        `)
        .run(upToId, consumer_id, project, upToId);
    return (getDb()
        .prepare("SELECT * FROM subscriptions WHERE consumer_id=? AND project=?")
        .get(consumer_id, project) as Subscription | undefined) ?? null;
}

export function markAllRead(
    consumer_id: string,
    project: string,
): Subscription | null {
    const head = (getDb()
        .prepare(`
            SELECT COALESCE(MAX(id), 0) AS m FROM messages
            WHERE project=? AND status='approved'
        `)
        .get(project) as { m: number }).m;
    return markRead(consumer_id, project, head);
}
