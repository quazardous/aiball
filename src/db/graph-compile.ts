// #1992 — the compiler. Reads the message log, emits `graph_edges`.
//
// The whole design rests on one measured fact: a full compile of the corpus
// (1992 tickets + 10965 comments, 13 MB of prose) takes ~200 ms. At that price
// an incremental compiler would be pure complexity — more code, more states,
// and a class of bug (a missed increment) that a full rebuild cannot have. So
// this only ever rebuilds everything, and the watermark exists solely to skip
// rebuilding when nothing moved.
//
// The artifact is CACHE. Nothing here is a source of truth, nothing is ever
// hand-edited, and dropping the table costs a recompile and nothing else.

import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";
import { extractMentions } from "./mention-extract.js";
import { needsRecompile, versionDrift, DEFAULT_MIN_DRIFT, type GraphVersion } from "./graph-version.js";

type Db = BetterSQLite3Database<typeof schema>;

/** The only edge kind this compiler emits today. */
export const MENTION_KIND = "mentions";

/**
 * How many edges go in one INSERT. SQLite caps bound parameters per statement
 * (32766 by default) and an edge binds 6, so a single statement would break
 * somewhere past ~5400 edges — which the corpus is already close to. Chunking
 * keeps that ceiling far away instead of near.
 */
const INSERT_CHUNK = 500;

/** The log's current signature — three integers, no prose read. */
export function readGraphVersion(db: Db): GraphVersion {
    const row = db.get<{ through_id: number | null; n: number; edited: number }>(sql`
        SELECT COALESCE(MAX(id), 0) AS through_id,
               COUNT(*)             AS n,
               COUNT(original_body) AS edited
        FROM _messages
    `);
    return {
        throughId: row?.through_id ?? 0,
        messageCount: row?.n ?? 0,
        editedCount: row?.edited ?? 0,
    };
}

/** What the artifact was built from, or null when nothing was ever compiled. */
export function readCompiledVersion(db: Db): GraphVersion | null {
    const row = db.get<{
        compiled_through_id: number;
        compiled_message_count: number;
        compiled_edited_count: number;
    }>(sql`
        SELECT compiled_through_id, compiled_message_count, compiled_edited_count
        FROM graph_meta WHERE id = 1
    `);
    if (!row) return null;
    return {
        throughId: row.compiled_through_id,
        messageCount: row.compiled_message_count,
        editedCount: row.compiled_edited_count,
    };
}

interface Edge {
    src: number;
    dst: number;
    weight: number;
    /** First occurrence wins as the citation — the earliest mention is the one
     * that established the link, and later repeats only add weight. */
    messageId: number | null;
    offset: number;
}

/**
 * Read every ticket reference in the corpus. Exported so the compile can be
 * measured and diffed without writing anything — which is how the constants in
 * `mention-extract` were checked against real prose in the first place.
 */
export function collectEdges(db: Db): Edge[] {
    const known = new Set<number>();
    for (const r of db.all<{ id: number }>(sql`SELECT id FROM tickets`)) known.add(r.id);

    const acc = new Map<string, Edge>();
    const take = (src: number, text: string | null, messageId: number | null) => {
        for (const m of extractMentions(text)) {
            // Existence is the corpus's question, not the extractor's: a `#N`
            // that names no ticket is prose about something else.
            if (!known.has(m.ticketId) || m.ticketId === src) continue;
            const key = `${src}:${m.ticketId}`;
            const seen = acc.get(key);
            if (seen) {
                seen.weight += 1;
                continue;
            }
            acc.set(key, { src, dst: m.ticketId, weight: 1, messageId, offset: m.offset });
        }
    };

    // A ticket's own body and title. `derived_message_id` stays null for these:
    // the source ticket is already named by `src_ticket_id`, so there is
    // nothing to point at beyond it.
    for (const t of db.all<{ id: number; body: string | null; title: string | null }>(
        sql`SELECT id, body, title FROM tickets`,
    )) {
        take(t.id, `${t.body ?? ""}\n${t.title ?? ""}`, null);
    }
    // Comment bodies — where 99% of the graph actually lives. Only approved
    // ones: a pending comment is not yet part of the record.
    for (const m of db.all<{ id: number; ticket_id: number; body: string | null }>(sql`
        SELECT id, ticket_id, body FROM _messages
        WHERE kind = 'comment_added' AND status = 'approved' AND body IS NOT NULL
        ORDER BY id ASC
    `)) {
        take(m.ticket_id, m.body, m.id);
    }
    return [...acc.values()];
}

/** Result of a compile, for logging and for the tools to report freshness. */
export interface CompileResult {
    edges: number;
    ms: number;
    version: GraphVersion;
}

/**
 * Rebuild the whole artifact. Wipes only this compiler's edge kind, so a future
 * kind can be compiled independently without this one trampling it.
 */
export function compileGraph(db: Db): CompileResult {
    const started = Date.now();
    // Read the version BEFORE the scan, never after: anything that lands while
    // we read would otherwise be stamped as already compiled and stay invisible
    // until the next unrelated event. Stamping slightly stale is safe — it
    // costs one extra recompile — while stamping slightly ahead loses edges.
    const version = readGraphVersion(db);
    const edges = collectEdges(db);
    db.transaction((tx) => {
        tx.run(sql`DELETE FROM graph_edges WHERE kind = ${MENTION_KIND}`);
        for (let i = 0; i < edges.length; i += INSERT_CHUNK) {
            tx.insert(schema.graphEdges).values(
                edges.slice(i, i + INSERT_CHUNK).map((e) => ({
                    srcTicketId: e.src,
                    dstTicketId: e.dst,
                    kind: MENTION_KIND,
                    weight: e.weight,
                    derivedMessageId: e.messageId,
                    derivedOffset: e.offset,
                })),
            ).run();
        }
        tx.run(sql`
            INSERT INTO graph_meta (id, compiled_through_id, compiled_message_count,
                                    compiled_edited_count, compiled_at, edge_count)
            VALUES (1, ${version.throughId}, ${version.messageCount},
                    ${version.editedCount}, ${new Date().toISOString()}, ${edges.length})
            ON CONFLICT(id) DO UPDATE SET
                compiled_through_id    = excluded.compiled_through_id,
                compiled_message_count = excluded.compiled_message_count,
                compiled_edited_count  = excluded.compiled_edited_count,
                compiled_at            = excluded.compiled_at,
                edge_count             = excluded.edge_count
        `);
    });
    return { edges: edges.length, ms: Date.now() - started, version };
}

/** What a consumer learns about freshness when it asks for the graph. */
export interface FreshResult {
    /** Whether this call rebuilt the artifact. */
    compiled: boolean;
    /** Events the artifact was behind before this call. 0 when it was current. */
    drift: number;
    /** Milliseconds spent compiling; 0 when nothing was rebuilt. */
    ms: number;
}

/**
 * Bring the artifact up to date if the log moved. This is the lazy read-path
 * trigger: no scheduler, no background task, no clock — the log's own ids say
 * whether there is anything to do, and a caller that asks a graph question
 * pays for the answer being right.
 */
export function ensureGraphFresh(db: Db, minDrift: number = DEFAULT_MIN_DRIFT): FreshResult {
    const current = readGraphVersion(db);
    const compiled = readCompiledVersion(db);
    const drift = versionDrift(current, compiled);
    if (!needsRecompile(current, compiled, minDrift)) return { compiled: false, drift: 0, ms: 0 };
    const res = compileGraph(db);
    return { compiled: true, drift, ms: res.ms };
}
