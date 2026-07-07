/**
 * #1200 — token-usage-over-time snapshots.
 *
 * A project's real token spend lives in TWO living aggregates: `project_token_usage`
 * (the no-marker/direct-session tally) AND `ticket_token_usage` (per-ticket, where
 * an active-ticket marker / held claim anchors the turn — #439). For a project
 * whose work is ticket-scoped, `project_token_usage` alone barely moves (that was
 * the "chart is flat" bug — the direct tally was frozen while 90%+ of usage sat in
 * `ticket_token_usage`). So we snapshot the COMBINED per-project total (direct +
 * SUM of its tickets' usage) into an append-only `token_usage_snapshot` table,
 * then read the series back.
 *
 * Deploy-safety: `ensureTable()` runs `CREATE TABLE IF NOT EXISTS` so the code
 * works whether or not migration 0052 has been applied yet (the live daemon
 * under tsx-watch doesn't re-run migrations on reload) — no crash, no forced
 * restart. Capture is THROTTLED (default hourly): a boot job ticks it, and the
 * read endpoint ticks it lazily, so the series populates even without a restart.
 */
import { getDb } from "./connection.js";
import { sql } from "drizzle-orm";

let ensured = false;
function ensureTable(): void {
    if (ensured) return;
    getDb().run(sql`
        CREATE TABLE IF NOT EXISTS token_usage_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            cache_w INTEGER NOT NULL DEFAULT 0,
            cache_r INTEGER NOT NULL DEFAULT 0
        )
    `);
    getDb().run(sql`
        CREATE INDEX IF NOT EXISTS idx_token_snapshot_project_time
        ON token_usage_snapshot(project, captured_at)
    `);
    ensured = true;
}

export interface TokenSnapshotRow {
    project: string;
    captured_at: string;
    tokens_in: number;
    tokens_out: number;
    cache_w: number;
    cache_r: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Capture a snapshot of every project's current token tally — but only for
 * projects whose latest snapshot is older than `intervalMs` (throttle, so
 * lazy read-triggered calls and the boot job don't over-insert). Returns the
 * number of rows written. `nowMs` injectable for tests.
 */
export function captureTokenSnapshotIfDue(
    intervalMs: number = DEFAULT_INTERVAL_MS,
    nowMs: number = Date.now(),
): { captured: number } {
    ensureTable();
    const db = getDb();
    const cutoff = new Date(nowMs - intervalMs).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    // Combined per-project total = direct tally + SUM of the project's per-ticket
    // usage. Projects whose combined tally hasn't been snapshotted within the
    // window are "due". UNION ALL then GROUP BY sums both sources; a project
    // present in only one source still appears.
    const due = db.all<{ project: string; tokens_in: number; tokens_out: number; cache_w: number; cache_r: number }>(sql`
        WITH combined AS (
            SELECT project, tokens_in, tokens_out, cache_w, cache_r
            FROM project_token_usage
            UNION ALL
            SELECT t.project AS project, tu.tokens_in, tu.tokens_out, tu.cache_w, tu.cache_r
            FROM ticket_token_usage tu
            JOIN tickets t ON t.id = tu.ticket_id
        ),
        totals AS (
            SELECT project,
                   SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                   SUM(cache_w) AS cache_w, SUM(cache_r) AS cache_r
            FROM combined
            GROUP BY project
        )
        SELECT p.project, p.tokens_in, p.tokens_out, p.cache_w, p.cache_r
        FROM totals p
        WHERE NOT EXISTS (
            SELECT 1 FROM token_usage_snapshot s
            WHERE s.project = p.project AND s.captured_at >= ${cutoff}
        )
    `);
    for (const r of due) {
        db.run(sql`
            INSERT INTO token_usage_snapshot (project, captured_at, tokens_in, tokens_out, cache_w, cache_r)
            VALUES (${r.project}, ${nowIso}, ${r.tokens_in}, ${r.tokens_out}, ${r.cache_w}, ${r.cache_r})
        `);
    }
    return { captured: due.length };
}

/** Read the snapshot series, optionally scoped to one project / a start time. */
export function getTokenTimeseries(opts: { project?: string; sinceMs?: number } = {}): TokenSnapshotRow[] {
    ensureTable();
    const since = opts.sinceMs ? new Date(opts.sinceMs).toISOString() : "";
    return getDb().all<TokenSnapshotRow>(sql`
        SELECT project, captured_at, tokens_in, tokens_out, cache_w, cache_r
        FROM token_usage_snapshot
        WHERE 1=1
          ${opts.project ? sql`AND project = ${opts.project}` : sql``}
          ${since ? sql`AND captured_at >= ${since}` : sql``}
        ORDER BY captured_at ASC, project ASC
    `);
}
