/**
 * #1200 — token-usage-over-time snapshots.
 *
 * `project_token_usage` is a LIVING aggregate (running total per project). To
 * chart usage over time we periodically snapshot each project's tallies into
 * an append-only `token_usage_snapshot` table, then read the series back.
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
    // Projects whose live tally hasn't been snapshotted within the window.
    const due = db.all<{ project: string; tokens_in: number; tokens_out: number; cache_w: number; cache_r: number }>(sql`
        SELECT p.project, p.tokens_in, p.tokens_out, p.cache_w, p.cache_r
        FROM project_token_usage p
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
