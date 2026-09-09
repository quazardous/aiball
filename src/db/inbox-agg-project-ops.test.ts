// #2168 — deleting, renaming or purging a project must leave the inbox
// aggregate holding what a cold rebuild would hold.
//
// These three writes never touched this cache. The symptom was small — wrong
// sidebar counters for at most the TTL, then self-healing — but the shape is
// the one #2165 spent a day removing: a write that changes the world and says
// nothing. The per-ticket repair of #2159 does not apply here, because the
// blast radius is a whole project and, for delete and purge, the tickets
// themselves are gone; the honest answer is to drop the map.
//
// `theHarnessCanFail` is the control: it performs the same destruction behind
// the API's back, so nothing clears the cache, and asserts the comparison DOES
// trip. Without it a green run would only prove the assertions are lenient.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2168-"));

const { eq } = await import("drizzle-orm");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject, deleteProject, renameProject, purgeOldClosedTickets } =
    await import("./projects.js");
const { buildInboxAgg, getInboxAgg, resetInboxAggCacheForTests } = await import("./inbox-agg.js");

const HUMAN = "david";
const AGENT = "claude-aiball-dev";

const db = getDb();
let seq = 0;
let nextTicket = 100;

function mkProject(name: string): string {
    createProject({ name });
    return name;
}

/** A ticket with one comment — enough for the fold to create an entry. */
function mkTicket(project: string, opts: { closedDaysAgo?: number } = {}): number {
    const id = nextTicket++;
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title: `T${id}`, status: "approved",
        byAgent: HUMAN, lastActor: HUMAN, lastActorAt: nowIso(), createdAt: nowIso(),
    }).run();
    db.insert(schema.messages).values({
        id: 70000 + ++seq, ticketId: id, kind: "comment_added", status: "approved",
        body: "text", byAgent: AGENT, displaySeq: ++seq, createdAt: nowIso(),
    }).run();
    if (opts.closedDaysAgo !== undefined) {
        const at = new Date(Date.now() - opts.closedDaysAgo * 86_400_000).toISOString();
        db.insert(schema.messages).values({
            id: 70000 + ++seq, ticketId: id, kind: "ticket_closed", status: "approved",
            byAgent: HUMAN, displaySeq: ++seq, createdAt: at,
        }).run();
    }
    return id;
}

/** Snapshot of every cached view, as ids → comment counts. */
const view = (project: string | undefined) =>
    [...getInboxAgg(project)].map(([id, a]) => `${id}:${a.commentCount}:${a.closed}`).sort();
const rebuilt = (project: string | undefined) =>
    [...buildInboxAgg(project)].map(([id, a]) => `${id}:${a.commentCount}:${a.closed}`).sort();

/** Fill both the project map and the cross-project one. */
function warm(...projects: (string | undefined)[]): void {
    resetInboxAggCacheForTests();
    for (const p of projects) getInboxAgg(p);
    getInboxAgg(undefined);
}

/**
 * The property: what the cache hands out after the write is what a cold build
 * would hand out. Checked on the cross-project view too — it counts every
 * project's tickets, so it goes stale on exactly the same writes and is the
 * half a per-project drop would forget.
 */
function assertCacheMatchesRebuild(projects: (string | undefined)[], label: string) {
    for (const p of [...projects, undefined]) {
        assert.deepEqual(view(p), rebuilt(p), `${label}: cached view of ${p ?? "ALL"} != rebuild`);
    }
}

test("deleting a project drops its counters, and the cross-project ones", () => {
    const a = mkProject("p2168-del"), b = mkProject("p2168-keep");
    mkTicket(a); mkTicket(a); const kept = mkTicket(b);
    warm(a, b);
    assert.equal(view(undefined).length, 3, "precondition: three tickets in the ALL view");

    deleteProject(a);

    assertCacheMatchesRebuild([a, b], "deleteProject");
    assert.equal(view(undefined).length, 1, "only the kept ticket remains");
    assert.ok(getInboxAgg(b).has(kept), "and the untouched project still counts");
});

test("renaming a project moves its counters to the new name", () => {
    const from = mkProject("p2168-from"), to = "p2168-to";
    const t = mkTicket(from);
    warm(from);
    assert.ok(getInboxAgg(from).has(t), "precondition: counted under the old name");

    renameProject(from, to);

    assertCacheMatchesRebuild([from, to], "renameProject");
    assert.ok(getInboxAgg(to).has(t), "counted under the new name");
    assert.ok(!getInboxAgg(from).has(t), "and no longer under the old one");
});

test("purging old closed tickets removes them from the counters", () => {
    const p = mkProject("p2168-purge");
    const old = mkTicket(p, { closedDaysAgo: 90 });
    const recent = mkTicket(p);
    warm(p);
    assert.equal(getInboxAgg(p).size, 2, "precondition: both counted");

    const r = purgeOldClosedTickets(p, 30);
    assert.equal(r.purged_tickets, 1, "precondition: the purge really removed one");

    assertCacheMatchesRebuild([p], "purgeOldClosedTickets");
    assert.ok(!getInboxAgg(p).has(old), "the purged ticket is gone from the counters");
    assert.ok(getInboxAgg(p).has(recent), "the recent one stays");
});

test("the harness can fail — a destruction behind the API's back is caught", () => {
    const p = mkProject("p2168-control");
    const t = mkTicket(p);
    warm(p);
    assert.ok(getInboxAgg(p).has(t), "precondition: counted");

    // Same destruction, straight to the tables, so nothing clears the cache.
    db.delete(schema.messages).where(eq(schema.messages.ticketId, t)).run();
    db.delete(schema.tickets).where(eq(schema.tickets.id, t)).run();

    assert.throws(
        () => assertCacheMatchesRebuild([p], "unwired destruction"),
        /!= rebuild/,
    );
});

after(() => {
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});
