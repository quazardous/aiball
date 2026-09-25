// #3008 — the projects list's two aggregates use the indexes of migration 0079.
// The plan is read from the SQL the code actually builds, so a rewrite that
// loses an index (a partial one only applies to literal terms) turns this red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3008-"));
process.env.AIBALL_SOCK = "";
const { getDb } = await import("./connection.js");
const { messageAggQuery, pendingResolutionQuery } = await import("./projects.js");
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));
getDb();

function plan(q: { toSQL(): { sql: string; params: unknown[] } }): string {
    const { sql, params } = q.toSQL();
    const raw = (getDb() as unknown as { $client: { prepare(s: string): { all(...p: unknown[]): { detail: string }[] } } }).$client;
    return raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(" | ");
}

test("the pending resolutions are read through the partial index", () => {
    assert.match(plan(pendingResolutionQuery()), /idx_messages_pending_resolution/);
});

test("the per-project message aggregate is answered from the covering index", () => {
    assert.match(plan(messageAggQuery(new Date().toISOString())), /COVERING INDEX idx_messages_ticket_kind_status_at/);
});
