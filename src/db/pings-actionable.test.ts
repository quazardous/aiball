// #643 — toutes les fonctions unread/pings (sidebar incluse) doivent
// appliquer le MÊME filtre actionable : exclure tickets closed (dernier
// lifecycle approved = `ticket_closed`) + snoozed (postponed_until > now).
// Pending est INCLUS (= "pas lu" indépendant du status moderation).
//
// Couvre les 4 fonctions de `src/db/pings.ts` qui alimentent badge sidebar,
// inbox feed, MCP `_status`, wake-phrase :
//   listUnread / unreadCount / listPings / unreadPingCount
//
// Setup : 4 tickets dans 1 projet, chacun avec 1 unread ping pour david :
//   T1 approved+open      → INCLUS
//   T2 pending+open       → INCLUS (revers du #456)
//   T3 approved+closed    → EXCLU (lifecycle ticket_closed)
//   T4 approved+snoozed   → EXCLU (postponed_until 1h dans le futur)
// Attendu : count = 2 (T1+T2), list = [T1, T2].
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

test("#643 unreadCount excludes closed + snoozed, includes pending", () => {
    assert.equal(unreadCount(RECIPIENT, PROJECT), 2);
});

test("#643 listUnread excludes closed + snoozed, includes pending", () => {
    const rows = listUnread(RECIPIENT, PROJECT);
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, [1, 2]);
});

test("#643 unreadPingCount excludes closed + snoozed, includes pending", () => {
    assert.equal(unreadPingCount(RECIPIENT), 2);
});

test("#643 listPings(unreadOnly) excludes closed + snoozed, includes pending", () => {
    const pings = listPings({ recipient: RECIPIENT, unreadOnly: true });
    const ids = pings.map((p) => p.message_id).sort();
    assert.deepEqual(ids, [1, 2]);
});

// Defensive : re-open T3 → it must reappear as unread.
test("#643 reopened ticket reappears as unread", () => {
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
