// #643 + #805 + #886 — toutes les fonctions unread/pings (sidebar
// incluse) appliquent le moteur `BacklogRules`. Cibles `unread-list` /
// `unread-count` excluent SNOOZED et SELF-AUTHORED uniquement. Closed
// est INCLUS (#805 : le prune se fait via MCP consult, pas par le gate).
//
// Couvre les 4 fonctions de `src/db/pings.ts` qui alimentent badge sidebar,
// inbox feed, MCP `_status`, wake-phrase :
//   listUnread / unreadCount / listPings / unreadPingCount
//
// Setup : 4 tickets dans 1 projet, chacun avec 1 unread ping pour david :
//   T1 approved+open      → INCLUS
//   T2 pending+open       → INCLUS (revers du #456)
//   T3 approved+closed    → INCLUS (#805 : visible jusqu'au prune-on-consult)
//   T4 approved+snoozed   → EXCLU (postponed_until 1h dans le futur)
// Attendu : count = 3 (T1+T2+T3), excluded = T4 only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-643b-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { insertPing, listUnread, unreadCount, listPings, unreadPingCount } = await import("./pings.js");
const { createProject } = await import("./projects.js");

const PROJECT = "p643b";
const RECIPIENT = "david";
const ACTOR = "claude-aiball-dev";

const db = getDb();
createProject({ name: PROJECT });

function mkTicket(id: number, status: "approved" | "pending", opts: { closed?: boolean; postponedUntil?: string } = {}) {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}`,
        status,
        byAgent: ACTOR,
        postponedUntil: opts.postponedUntil ?? null,
        createdAt: nowIso(),
    }).run();
    if (opts.closed) {
        db.insert(schema.messages).values({
            ticketId: id,
            kind: "ticket_closed",
            status: "approved",
            byAgent: ACTOR,
            displaySeq: 1000 + id,
            createdAt: nowIso(),
            decidedAt: nowIso(),
            decidedBy: "auto",
        }).run();
    }
    insertPing(RECIPIENT, { id, kind: "ticket_created" }, ACTOR);
}

mkTicket(1, "approved");
mkTicket(2, "pending");
mkTicket(3, "approved", { closed: true });
const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
mkTicket(4, "approved", { postponedUntil: inOneHour });

test("#805 unreadCount includes closed (visible jusqu'à prune-on-consult), excludes snoozed", () => {
    assert.equal(unreadCount(RECIPIENT, PROJECT), 3);
});

test("#805 listUnread includes closed, excludes snoozed", () => {
    const rows = listUnread(RECIPIENT, PROJECT);
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, [1, 2, 3]);
});

test("#805 unreadPingCount includes closed, excludes snoozed", () => {
    assert.equal(unreadPingCount(RECIPIENT), 3);
});

test("#805 listPings(unreadOnly) includes closed, excludes snoozed", () => {
    const pings = listPings({ recipient: RECIPIENT, unreadOnly: true });
    const ids = pings.map((p) => p.message_id).sort();
    assert.deepEqual(ids, [1, 2, 3]);
});

// Defensive : re-open T3 (already INCLUS post-#805). Sanity : count unchanged.
test("#643 reopened ticket stays unread (was already visible)", () => {
    db.insert(schema.messages).values({
        ticketId: 3,
        kind: "ticket_reopened",
        status: "approved",
        byAgent: ACTOR,
        displaySeq: 2003,
        createdAt: nowIso(),
        decidedAt: nowIso(),
        decidedBy: "auto",
    }).run();
    assert.equal(unreadCount(RECIPIENT, PROJECT), 3);
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});
