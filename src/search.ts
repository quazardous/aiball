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
 * #285: the FTS tables now use the `trigram` tokenizer (migration 0022),
 * so a quoted token in a `MATCH` query does SUBSTRING matching — `"broad"`
 * hits "broadcast", `"cast"` hits "broadcast" too. That's the whole point:
 * the old `unicode61` tokenizer only matched whole words.
 *
 * Trigram caveat: it indexes 3-char windows, so a search token MUST be ≥3
 * chars to use the index — a 1-2 char token in `MATCH` matches nothing
 * (verified: returns empty, not an error). So we split the query:
 *   - tokens ≥3 chars  → quoted phrase literals in `MATCH` (FTS5 ANDs them).
 *   - tokens 1-2 chars → applied as `LIKE %tok%` narrowing on the base
 *     columns (so they still filter without breaking the trigram MATCH).
 * When the WHOLE query is short tokens, there's no usable MATCH term, so
 * `searchMessages` falls back to a pure `LIKE` scan of the base tables.
 *
 * Quoting chars (`"()\*`) are stripped first so a stray bracket / unbalanced
 * quote can't throw a `MATCH` syntax error.
 */
interface ParsedQuery {
    /** FTS5 MATCH string built from the ≥3-char tokens, or null when the
     *  query has none (→ caller takes the LIKE-only fallback path). */
    match: string | null;
    /** 1-2 char tokens, applied as LIKE narrowing on base columns. */
    likeTokens: string[];
    /** True when the query has no usable tokens at all (→ empty result). */
    empty: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
    const tokens = raw
        .trim()
        .split(/\s+/)
        // strip FTS5 quoting / prefix chars so the wrap below can't escape
        .map((t) => t.replace(/["()\\*]/g, ""))
        .filter((t) => t.length > 0);
    const long = tokens.filter((t) => t.length >= 3);
    const short = tokens.filter((t) => t.length < 3);
    return {
        match: long.length > 0 ? long.map((t) => `"${t}"`).join(" ") : null,
        likeTokens: short,
        empty: tokens.length === 0,
    };
}

/** Build a `LIKE` argument for a token, escaping the LIKE wildcards so a
 *  literal `%`/`_`/`\` in the search term doesn't act as a wildcard. The
 *  SQL side pairs this with `ESCAPE '\'`. */
function likeArg(token: string): string {
    return "%" + token.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
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
    const q = parseQuery(rawQuery);
    if (q.empty) return [];
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

    const sqlite = getRawSqlite();

    // FTS path when there's at least one ≥3-char token (trigram MATCH does
    // the substring work); otherwise (query is only 1-2 char tokens) fall
    // back to a plain LIKE scan of the base tables — no trigram index to
    // lean on, but it keeps short fragments working without a syntax error.
    const fts = q.match !== null;

    // ---- Tickets ----
    const ticketWhere: string[] = [];
    const ticketArgs: unknown[] = [];
    if (q.match) {
        ticketWhere.push("tickets_fts MATCH ?");
        ticketArgs.push(q.match);
    }
    ticketWhere.push("t.status != 'rejected'");
    for (const tok of q.likeTokens) {
        ticketWhere.push("(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\')");
        const a = likeArg(tok);
        ticketArgs.push(a, a);
    }
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
            ${fts ? "snippet(tickets_fts, -1, '<mark>', '</mark>', '…', 24)" : "substr(COALESCE(t.body, t.title, ''), 1, 120)"} AS snippet,
            ${fts ? "tickets_fts.rank" : "0"} AS rank
        ${fts ? "FROM tickets_fts JOIN tickets t ON t.id = tickets_fts.rowid" : "FROM tickets t"}
        WHERE ${ticketWhere.join(" AND ")}
        ${fts ? "ORDER BY rank" : "ORDER BY t.id DESC"}
        LIMIT ?
    `).all(...ticketArgs) as TicketHitRow[];

    // Then comments / lifecycle bodies. Reject filter + open filter is
    // applied to the *parent* ticket (the comment itself isn't gated).
    const msgWhere: string[] = [];
    const msgArgs: unknown[] = [];
    if (q.match) {
        msgWhere.push("messages_fts MATCH ?");
        msgArgs.push(q.match);
    }
    msgWhere.push("m.status != 'rejected'");
    msgWhere.push("t.status != 'rejected'");
    for (const tok of q.likeTokens) {
        msgWhere.push("m.body LIKE ? ESCAPE '\\'");
        msgArgs.push(likeArg(tok));
    }
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
            ${fts ? "snippet(messages_fts, -1, '<mark>', '</mark>', '…', 24)" : "substr(COALESCE(m.body, ''), 1, 120)"} AS snippet,
            ${fts ? "messages_fts.rank" : "0"} AS rank
        ${fts ? "FROM messages_fts JOIN _messages m ON m.id = messages_fts.rowid JOIN tickets t ON t.id = m.ticket_id" : "FROM _messages m JOIN tickets t ON t.id = m.ticket_id"}
        WHERE ${msgWhere.join(" AND ")}
        ${fts ? "ORDER BY rank" : "ORDER BY m.id DESC"}
        LIMIT ?
    `).all(...msgArgs) as MessageHitRow[];

    // Optional `open` filter applied after the fact so the SQL stays
    // simple (we need lifecycle replay to know if a ticket is closed,
    // which is expensive to inline here). The inbox endpoint does the
    // same dance.
    //
    // #B.135: also exclude tickets closed via the lifecycle (ticket_closed
    // event with no later ticket_reopened). Previously only rejected
    // tickets were filtered out — david: "la recherche devrait respecter
    // les filtres, le only-open laisse passer des tickets fermés".
    // Cheap pre-pass over the candidate ids only.
    const candidateIds = new Set<number>();
    for (const r of ticketRows) candidateIds.add(r.id);
    for (const r of messageRows) candidateIds.add(r.ticket_id);
    const closedTicketIds = new Set<number>();
    if (opts.open && candidateIds.size > 0) {
        const placeholders = Array.from(candidateIds).map(() => "?").join(",");
        const ids = Array.from(candidateIds);
        const rows = sqlite.prepare(`
            SELECT t.id AS id
            FROM tickets t
            WHERE t.id IN (${placeholders})
              AND EXISTS (
                SELECT 1 FROM _messages c
                WHERE c.ticket_id = t.id
                  AND c.kind = 'ticket_closed'
                  AND c.status = 'approved'
                  AND c.id > COALESCE(
                    (SELECT MAX(r.id) FROM _messages r
                     WHERE r.ticket_id = t.id
                       AND r.kind = 'ticket_reopened'
                       AND r.status = 'approved'),
                    0
                  )
              )
        `).all(...ids) as { id: number }[];
        for (const r of rows) closedTicketIds.add(r.id);
    }
    const hits: SearchHit[] = [];
    for (const r of ticketRows) {
        if (opts.open && r.status === "rejected") continue;
        if (opts.open && closedTicketIds.has(r.id)) continue;
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
        if (opts.open && r.ticket_status === "rejected") continue;
        if (opts.open && closedTicketIds.has(r.ticket_id)) continue;
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
