// #643 — david `nch7je`: an unread is "something I haven't read",
// regardless of moderation status. The sidebar badge `unread_for_consumer`
// used to exclude PENDING tickets (`status !== "approved"`) on top of
// closed+snoozed, because of the #456 fix. bame repro: 1 pending ticket
// with a ping for david → API `/api/unread/count` = 1, sidebar badge = 0.
//
// David `nch7je` redefines the semantics: pending COUNTS as unread
// (nothing stops you having seen it), snoozed stays excluded (pushed back
// in time), closed stays excluded (no longer actionable).
//
// This test pins the new invariant + re-checks closed/snoozed so we
// don't lose their exclusion by accident.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-643-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { insertPing } = await import("./pings.js");
const { listProjectsDetailed, createProject } = await import("./projects.js");

const PROJECT = "p643";
const RECIPIENT = "david";
const ACTOR = "claude-aiball-dev";

const db = getDb();
createProject({ name: PROJECT });

function mkTicket(id: number, status: "approved" | "pending", opts: { closed?: boolean; postponedUntil?: string } = {}) {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id} (${status}${opts.closed ? ", closed" : ""}${opts.postponedUntil ? ", snoozed" : ""})`,
        status,
        byAgent: ACTOR,
        postponedUntil: opts.postponedUntil ?? null,
        createdAt: nowIso(),
    }).run();
    // The closed-by-lifecycle map is built from approved `ticket_closed`
    // messages — emit one so the sidebar excludes T3 the same way the
    // live code path does.
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
    // A ping from ACTOR → RECIPIENT, unseen.
    insertPing(RECIPIENT, { id, kind: "ticket_created" }, ACTOR);
}

// Ticket 1 : approved + open + not snoozed → should count.
mkTicket(1, "approved");
// Ticket 2 : pending + open + not snoozed → must NOW count (was excluded pre-#643).
mkTicket(2, "pending");
// Ticket 3 : approved + closed → must NOT count.
mkTicket(3, "approved", { closed: true });
// Ticket 4 : approved + snoozed 1h in the future → must NOT count.
const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
mkTicket(4, "approved", { postponedUntil: inOneHour });

test("#643 sidebar unread_for_consumer INCLUDES pending, EXCLUDES closed+snoozed", () => {
    const projects = listProjectsDetailed(RECIPIENT);
    const p = projects.find((x) => x.name === PROJECT);
    assert.ok(p, `project ${PROJECT} must surface`);
    // 1 (approved) + 2 (pending) = 2 unread. 3 (closed) + 4 (snoozed) excluded.
    assert.equal(p!.unread_for_consumer, 2, `expected 2 unread (approved+pending), got ${p!.unread_for_consumer}`);
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});
