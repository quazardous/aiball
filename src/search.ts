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

import { expandToken } from "./search-synonyms.js";
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
    /** Ticket title. For kind=ticket this is the matched ticket itself; for
     *  kind=comment this is the PARENT ticket's title (#842) so the result
     *  row carries the thread context. Nullable only when the underlying
     *  ticket has no title set. */
    title: string | null;
    /** A short hashid we can show for comment hits, mirroring `#C.<hashid>`
     *  in the UI. Null for ticket hits. */
    hashid: string | null;
    by_agent: string | null;
    created_at: string;
    status: string;
    /** Highlighted snippet around the match (HTML-safe: <mark> tags). */
    snippet: string;
    /** #2193 — the whole line the match sits on, unmarked, for a grep-shaped
     *  read. Null when the query matched nothing quotable (short-token LIKE
     *  fallback, or a match only inside a field this does not scan). */
    line: string | null;
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
    /** #798 — ISO 8601 cutoff. Filters hits whose ticket OR comment
     *  `created_at` is >= since. Useful for "what matched <query>
     *  since 1h". Date.parse-friendly. */
    since?: string;
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
    /** #2193 — the ≥3-char tokens as written, for the whole-word re-rank.
     *  Deliberately NOT the expanded set: the re-rank must reward the word the
     *  caller typed, not a synonym the dictionary added — otherwise a hit that
     *  only matches through expansion sorts as high as an exact one. */
    wordTokens: string[];
    /** #2193 — the groups that actually grew, for the result header. Empty
     *  when nothing was expanded, which is the common case. */
    expanded: string[][];
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
    // #2193 — each token becomes a GROUP: OR inside, AND between. That keeps
    // the existing meaning of a multi-word query ("both words", never
    // "either") while letting `réveil` also reach the threads that say `wake`.
    const groups = long.map((t) => expandToken(t));
    const expanded = groups.filter((g) => g.length > 1);
    return {
        match: long.length > 0
            ? groups.map((g) => g.length > 1
                ? `(${g.map((t) => `"${t}"`).join(" OR ")})`
                : `"${g[0]}"`).join(" ")
            : null,
        expanded,
        likeTokens: short,
        /** #2193 — the ≥3-char tokens, kept for the whole-word re-rank. */
        wordTokens: long,
        empty: tokens.length === 0,
    };
}



/**
 * #2193 — normalise for the whole-word test: lowercase, and strip combining
 * marks so `modération` and `moderation` compare equal.
 *
 * This has to mirror what the trigram tokenizer already does, or the bonus
 * would DEMOTE a correct hit: searching `moderation` finds `modération`
 * through FTS5, and a strict word test would then score it zero and push it
 * behind the substring noise — the opposite of the point.
 */
function foldForWordTest(s: string): string {
    return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * #2193 — how many of the query's tokens appear as WHOLE WORDS in this row.
 *
 * The trigram tokenizer matches substrings, which is what gives `broad` →
 * `broadcast` and is worth keeping. What it costs is precision on short
 * tokens: measured on this corpus, `lock` returns 132 tickets of which 86
 * (65 %) match only through `block` / `blocked` — and `blocked` is a ticket
 * STATE here, not a lock.
 *
 * So the substring stays the RECALL rule and this becomes the ORDER rule.
 * Nothing is filtered out; the rows that contain the actual word simply sort
 * first. A row scoring zero is still returned, just below.
 *
 * The boundary is Unicode-aware on purpose: JS `\b` is ASCII-only, so
 * `\bréveil\b` would not behave — the accented letter reads as a non-word
 * character and the assertion fires in the middle of the word.
 */
export function wholeWordScore(tokens: readonly string[], ...parts: (string | null)[]): number {
    if (tokens.length === 0) return 0;
    const hay = foldForWordTest(parts.filter((p): p is string => !!p).join(" "));
    let score = 0;
    for (const t of tokens) {
        const tok = foldForWordTest(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(?<![\\p{L}\\p{N}_])${tok}(?![\\p{L}\\p{N}_])`, "u").test(hay)) score++;
    }
    return score;
}


/**
 * #2193 — the LINE a match sits on, for a grep-shaped result (david `x925yv`:
 * "la recherche devrait ressembler à du grep, càd le mot [et] une ligne de
 * contexte").
 *
 * FTS5's `snippet()` gives a 24-token window with `<mark>` tags around the
 * hit. That is right for the web UI, which highlights, and wrong for an agent,
 * which reads: it truncates mid-word, carries markup, and can contain newlines
 * — `"… prend un <mark>verrou</mark> d'écritur…"`. A whole line reads as a
 * sentence instead.
 *
 * "One line of context" is read here as THE line carrying the word, not ±1
 * around it à la `grep -C1`; that reading is stated on the ticket.
 *
 * Returned alongside `snippet`, never instead of it — the UI still wants its
 * marked-up window.
 */
function matchLine(tokens: readonly string[], ...parts: (string | null)[]): string | null {
    if (tokens.length === 0) return null;
    const folded = tokens.map(foldForWordTest);
    for (const part of parts) {
        if (!part) continue;
        for (const raw of part.split("\n")) {
            const line = raw.trim();
            if (!line) continue;
            const hay = foldForWordTest(line);
            if (folded.some((t) => hay.includes(t))) {
                return line.length > MATCH_LINE_MAX
                    ? line.slice(0, MATCH_LINE_MAX).replace(/\s+\S*$/, "") + "…"
                    : line;
            }
        }
    }
    return null;
}

/** Wide enough for a sentence, short enough that a wall of results stays a
 *  list. Cut at a word boundary so it never ends mid-word — the very thing
 *  that made `snippet()` hard to read. */
const MATCH_LINE_MAX = 160;

/**
 * #2193 — the opening line of a body, for the hashid fast-path.
 *
 * There, the query IS the identifier: no word of it appears in the text, so
 * `matchLine` has nothing to find. What a grep-shaped reader wants is still a
 * line — the first real one, the way `head -1` would answer "what is this".
 */
function firstLine(body: string | null): string | null {
    for (const raw of (body ?? "").split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        return line.length > MATCH_LINE_MAX
            ? line.slice(0, MATCH_LINE_MAX).replace(/\s+\S*$/, "") + "…"
            : line;
    }
    return null;
}

/**
 * #2193 — the re-rank reads rows the SQL `LIMIT` would have cut, so each
 * source is asked for more than the caller wants. Without it the fix misses
 * exactly the case it targets: a row holding the real word, ranked below the
 * substring noise, never reaches the sort.
 */
const OVERFETCH = 4;

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
    /** Parent ticket title — so a comment hit can show the thread it belongs
     *  to, not just `#C.<hashid>` + fragment (#842 david `<hashid>`). */
    ticket_title: string | null;
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

    // #889 — hashid fast-path : si la query est un slug isolé (6+ chars
    // lowercase alphanumeric), tenter un lookup direct sur _messages.hashid
    // AVANT FTS. Les hashids ne sont pas indexés dans FTS5 (= invisible
    // au tokenizer trigram), donc sans ce shortcut `search("f33ejb")`
    // retourne 0 hit même quand le comment existe.
    const slugMatch = rawQuery.trim().match(/^[a-z0-9]{6,}$/);
    if (slugMatch) {
        const row = sqlite.prepare(`
            SELECT m.id, m.ticket_id, m.hashid, m.body, m.by_agent,
                   m.created_at, m.status,
                   t.project, t.status AS ticket_status, t.title AS ticket_title
            FROM _messages m JOIN tickets t ON t.id = m.ticket_id
            WHERE m.hashid = ?
              AND m.status != 'rejected'
              AND t.status != 'rejected'
              ${opts.project ? "AND t.project = ?" : ""}
              ${opts.intent ? "AND t.intent = ?" : ""}
            LIMIT 1
        `).get(...[slugMatch[0], opts.project, opts.intent].filter((x) => x !== undefined)) as MessageHitRow | undefined;
        if (row) {
            // Apply open filter (closed-by-lifecycle check) if asked.
            let skipForOpen = false;
            if (opts.open) {
                const closed = sqlite.prepare(`
                    SELECT 1 FROM _messages c
                    WHERE c.ticket_id = ?
                      AND c.kind = 'ticket_closed'
                      AND c.status = 'approved'
                      AND c.id > COALESCE(
                        (SELECT MAX(r.id) FROM _messages r
                         WHERE r.ticket_id = c.ticket_id
                           AND r.kind = 'ticket_reopened'
                           AND r.status = 'approved'),
                        0
                      )
                    LIMIT 1
                `).get(row.ticket_id);
                if (closed) skipForOpen = true;
            }
            if (!skipForOpen) {
                return [{
                    kind: "comment",
                    id: row.id,
                    ticket_id: row.ticket_id,
                    project: row.project,
                    title: row.ticket_title,
                    hashid: row.hashid,
                    by_agent: row.by_agent,
                    created_at: row.created_at,
                    status: row.status,
                    snippet: (row.body ?? "").slice(0, 120),
                    rank: 0,
                    line: firstLine(row.body),
                }];
            }
        }
        // Fallthrough : pas de hit hashid → continue avec le FTS normal
        // (= au cas où le slug est aussi du contenu textuel quelque part).
    }

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
    if (opts.since) {
        ticketWhere.push("t.created_at >= ?");
        ticketArgs.push(opts.since);
    }
    ticketArgs.push(limit * OVERFETCH);
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
    if (opts.since) {
        msgWhere.push("m.created_at >= ?");
        msgArgs.push(opts.since);
    }
    msgArgs.push(limit * OVERFETCH);
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
            t.title             AS ticket_title,
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
    // #2193 — `words` rides along only to order the merge; it is stripped
    // before the result leaves this function, so the public shape is unchanged.
    const hits: (SearchHit & { words: number })[] = [];
    const wordTokens = q.wordTokens;
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
            line: matchLine(wordTokens, r.title, r.body),
            words: wholeWordScore(wordTokens, r.title, r.body),
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
            // #842: surface the parent ticket title on comment hits so the
            // result row reads as "#C.<hashid> – <ticket title> – <snippet>"
            // instead of just "<hashid> – <snippet>" with no thread context.
            title: r.ticket_title,
            hashid: r.hashid,
            by_agent: r.by_agent,
            created_at: r.created_at,
            status: r.status,
            snippet: r.snippet,
            rank: r.rank,
            line: matchLine(wordTokens, r.body, r.ticket_title),
            words: wholeWordScore(wordTokens, r.ticket_title, r.body),
        });
    }
    // #2193 — whole-word matches first, FTS5 rank inside each band. The
    // substring rule still decides WHAT comes back; it no longer decides the
    // order. `words` is internal to the sort and dropped from the result.
    hits.sort((a, b) => (b.words - a.words) || (a.rank - b.rank));
    return hits.slice(0, limit).map(({ words: _w, ...hit }) => hit);
}
