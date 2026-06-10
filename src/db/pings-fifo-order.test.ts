// #895 — FIFO sort by created_at (pas par id) dans `listUnread`.
//
// Migration #0007 a partitionné les ID ranges :
//   - tickets   : `_messages.id` ∈ [1, 999_999]
//   - comments  : `_messages.id` ∈ [1_000_000, ∞)
//
// Sort par `id ASC` plaçait un nouveau ticket (id=894) AVANT un comment
// ancien (id=1_007_717), même si le comment a été créé avant. Le fix
// `pings.ts:498` sort par `created_at.localeCompare` (ISO timestamp
// lexicographique = chronologique).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-895-"));

const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { insertPing, listUnread } = await import("./pings.js");
const { createProject } = await import("./projects.js");

const PROJECT = "p895";
const RECIPIENT = "david";
const ACTOR = "claude-aiball-dev";

const db = getDb();
createProject({ name: PROJECT });

// Setup :
//   T_OLD (id=10)  ticket   created_at=10:00
//   C_MID (id=1_000_001)  comment   created_at=11:00
//   T_NEW (id=20)  ticket   created_at=12:00
//   C_NEW (id=1_000_002)  comment   created_at=13:00
//
// Si sort par id : ordre observé = T_OLD, T_NEW, C_MID, C_NEW (= bug).
// Si sort par created_at : ordre attendu = T_OLD, C_MID, T_NEW, C_NEW.
db.insert(schema.tickets).values({
    id: 10,
    project: PROJECT,
    displaySeq: 1,
    title: "T_OLD",
    status: "approved",
    byAgent: ACTOR,
    createdAt: "2026-06-10T10:00:00.000Z",
}).run();
insertPing(RECIPIENT, { id: 10, kind: "ticket_created" }, ACTOR);

db.insert(schema.messages).values({
    id: 1_000_001,
    ticketId: 10,
    kind: "comment_added",
    status: "approved",
    body: "C_MID",
    byAgent: ACTOR,
    displaySeq: 2,
    createdAt: "2026-06-10T11:00:00.000Z",
    decidedAt: "2026-06-10T11:00:00.000Z",
    decidedBy: "auto",
}).run();
insertPing(RECIPIENT, { id: 1_000_001, kind: "comment_added" }, ACTOR);

db.insert(schema.tickets).values({
    id: 20,
    project: PROJECT,
    displaySeq: 3,
    title: "T_NEW",
    status: "approved",
    byAgent: ACTOR,
    createdAt: "2026-06-10T12:00:00.000Z",
}).run();
insertPing(RECIPIENT, { id: 20, kind: "ticket_created" }, ACTOR);

db.insert(schema.messages).values({
    id: 1_000_002,
    ticketId: 20,
    kind: "comment_added",
    status: "approved",
    body: "C_NEW",
    byAgent: ACTOR,
    displaySeq: 4,
    createdAt: "2026-06-10T13:00:00.000Z",
    decidedAt: "2026-06-10T13:00:00.000Z",
    decidedBy: "auto",
}).run();
insertPing(RECIPIENT, { id: 1_000_002, kind: "comment_added" }, ACTOR);

test("listUnread sorts chronologically — new ticket NE PASSE PAS devant un comment plus ancien", () => {
    const rows = listUnread(RECIPIENT, PROJECT);
    const ids = rows.map((r) => r.id);
    // Ordre attendu chrono : T_OLD (10:00), C_MID (11:00), T_NEW (12:00), C_NEW (13:00).
    // Avec sort par id (bug) on aurait : 10, 20, 1_000_001, 1_000_002.
    assert.deepEqual(ids, [10, 1_000_001, 20, 1_000_002]);
});

test("listUnread cross-vérifie via created_at strictement ascendant", () => {
    const rows = listUnread(RECIPIENT, PROJECT);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1].created_at.localeCompare(rows[i].created_at) <= 0,
            `rows[${i - 1}].created_at (${rows[i - 1].created_at}) <= rows[${i}].created_at (${rows[i].created_at})`,
        );
    }
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});
