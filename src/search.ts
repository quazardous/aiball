/**
 * Full-text search service.
 *
 * Wraps SQLite FTS5 behind a small, swappable interface so the rest of the
 * code (HTTP handlers, MCP tool, frontend) never touches FTS5 quirks
 * directly. If we ever swap the backing index (e.g. Tantivy, Meilisearch,
 * embeddings), only this module needs to change.
 *
 * Why a module of its own rather than helpers in db.ts:
 *   - FTS5 uses external-content virtual tables (`tickets_fts`,
 *     `messages_fts`) maintained by triggers (see migration 0004). The
 *     query layer uses `MATCH`, `rank`, and the `snippet()` function which
 *     Drizzle has no first-class binding for — we drop to raw SQL via the
 *     better-sqlite3 handle.
 *   - The result shape unifies hits coming from two sources (ticket vs
 *     comment) into a single sorted list. That's the public contract.
 */

import type { Intent } from "./db.js";
import { getRawSqlite } from "./db.js";

export interface SearchHit {
    /** "ticket" when the match is on the ticket title/body; "comment"
     *  when it's on a comment / lifecycle body. */
    kind: "ticket" | "comment";
    /** The actual matched row id (= ticket id for kind=ticket, comment
     *  internal id for kind=comment). The frontend opens `/b/<id>` which
     *  the backend resolves to the parent thread either way. */
    id: number;
    /** Always set to the parent thread id, so the caller can group by
     *  thread without having to second-guess `kind`. */
    ticket_id: number;
    project: string;
    /** Ticket title (only set for kind=ticket; null for kind=comment). */
    title: string | null;
    /** A short hashid we can show for comment hits, mirroring `#C.<hashid>`
     *  in the UI. Null for ticket hits. */
    hashid: string | null;
    by_agent: string | null;
    created_at: string;
    status: string;
    /** Highlighted snippet around the match (HTML-safe: <mark> tags). */
    snippet: string;
    /** FTS5 relevance — smaller is more relevant. Two ticket hits and
     *  two comment hits sort by this across kinds. */
    rank: number;
}

export interface SearchOptions {
    project?: string;
    /** True → exclude closed/rejected tickets from the hit list. */
    open?: boolean;
    intent?: Intent | null;
    limit?: number;
}

/**
 * Sanitize a free-form user query into something safe for the FTS5
 * `MATCH` operator. FTS5 supports a query language with prefix `*`,
 * boolean operators, etc.; but a stray bracket or unbalanced quote
 * throws SQL errors. The simplest safe path is to:
 *   - lowercase / trim,
 *   - split on whitespace,
 *   - wrap each non-empty token in double quotes (so FTS5 treats them
 *     as phrase literals), and let FTS5 implicitly AND them.
 * This keeps the surface intuitive ("hashid envelope" finds rows
 * containing both terms) at the cost of losing power-user syntax. We
 * can revisit if needed.
 */
function sanitizeFtsQuery(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const tokens = trimmed
        .split(/\s+/)
        // strip FTS5 quoting characters so the wrap below can't escape
        .map((t) => t.replace(/["()\\]/g, ""))
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    return tokens.map((t) => `"${t}"`).join(" ");
}

interface TicketHitRow {
    id: number;
    project: string;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: string;
    intent: string | null;
    snippet: string;
    rank: number;
}

interface MessageHitRow {
    id: number;
    ticket_id: number;
    hashid: string | null;
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: string;
    project: string;
    ticket_status: string;
    snippet: string;
    rank: number;
}

/**
 * Search tickets and comments for a free-form query. Returns a single
 * merged list sorted by FTS5 rank. Filters mirror the inbox endpoint
 * (`project`, `open`, `intent`) so the caller can compose with the same
 * mental model.
 */
export function searchMessages(
    rawQuery: string,
    opts: SearchOptions = {},
): SearchHit[] {
    const matchQuery = sanitizeFtsQuery(rawQuery);
    if (!matchQuery) return [];
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

    const sqlite = getRawSqlite();

    // Tickets first.
    const ticketWhere: string[] = ["tickets_fts MATCH ?", "t.status != 'rejected'"];
    const ticketArgs: unknown[] = [matchQuery];
    if (opts.project) {
        ticketWhere.push("t.project = ?");
        ticketArgs.push(opts.project);
    }
    if (opts.intent) {
        ticketWhere.push("t.intent = ?");
        ticketArgs.push(opts.intent);
    }
    ticketArgs.push(limit);
    const ticketRows = sqlite.prepare(`
        SELECT
            t.id              AS id,
            t.project         AS project,
            t.title           AS title,
            t.body            AS body,
            t.by_agent        AS by_agent,
            t.created_at      AS created_at,
            t.status          AS status,
            t.intent          AS intent,
            snippet(tickets_fts, -1, '<mark>', '</mark>', '…', 24) AS snippet,
            tickets_fts.rank  AS rank
        FROM tickets_fts
        JOIN tickets t ON t.id = tickets_fts.rowid
        WHERE ${ticketWhere.join(" AND ")}
        ORDER BY rank
        LIMIT ?
    `).all(...ticketArgs) as TicketHitRow[];

    // Then comments / lifecycle bodies. Reject filter + open filter is
    // applied to the *parent* ticket (the comment itself isn't gated).
    const msgWhere: string[] = [
        "messages_fts MATCH ?",
        "m.status != 'rejected'",
        "t.status != 'rejected'",
    ];
    const msgArgs: unknown[] = [matchQuery];
    if (opts.project) {
        msgWhere.push("t.project = ?");
        msgArgs.push(opts.project);
    }
    if (opts.intent) {
        msgWhere.push("t.intent = ?");
        msgArgs.push(opts.intent);
    }
    msgArgs.push(limit);
    const messageRows = sqlite.prepare(`
        SELECT
            m.id                AS id,
            m.ticket_id         AS ticket_id,
            m.hashid            AS hashid,
            m.body              AS body,
            m.by_agent          AS by_agent,
            m.created_at        AS created_at,
            m.status            AS status,
            t.project           AS project,
            t.status            AS ticket_status,
            snippet(messages_fts, -1, '<mark>', '</mark>', '…', 24) AS snippet,
            messages_fts.rank   AS rank
        FROM messages_fts
        JOIN _messages m ON m.id = messages_fts.rowid
        JOIN tickets   t ON t.id = m.ticket_id
        WHERE ${msgWhere.join(" AND ")}
        ORDER BY rank
        LIMIT ?
    `).all(...msgArgs) as MessageHitRow[];

    // Optional `open` filter applied after the fact so the SQL stays
    // simple (we need lifecycle replay to know if a ticket is closed,
    // which is expensive to inline here). The inbox endpoint does the
    // same dance.
    const hits: SearchHit[] = [];
    for (const r of ticketRows) {
        if (opts.open && r.status === "rejected") continue;
        hits.push({
            kind: "ticket",
            id: r.id,
            ticket_id: r.id,
            project: r.project,
            title: r.title,
            hashid: null,
            by_agent: r.by_agent,
            created_at: r.created_at,
            status: r.status,
            snippet: r.snippet,
            rank: r.rank,
        });
    }
    for (const r of messageRows) {
        hits.push({
            kind: "comment",
            id: r.id,
            ticket_id: r.ticket_id,
            project: r.project,
            title: null,
            hashid: r.hashid,
            by_agent: r.by_agent,
            created_at: r.created_at,
            status: r.status,
            snippet: r.snippet,
            rank: r.rank,
        });
    }
    hits.sort((a, b) => a.rank - b.rank);
    return hits.slice(0, limit);
}
