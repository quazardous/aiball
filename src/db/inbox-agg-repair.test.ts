// #2159 — repairing one entry of the inbox aggregate must be indistinguishable
// from throwing the map away and rebuilding it.
//
// The module deliberately chose drop-and-rebuild so that "no incremental-update
// code" could diverge from the fold. The repair keeps that promise by RE-RUNNING
// the fold over one thread instead of applying a delta — these tests are what
// says so out loud, on a ticket carrying every shape the reduction handles:
// comments, pending comments, a decision, and a close/reopen lifecycle.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2159-"));

const { eq } = await import("drizzle-orm");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { buildInboxAgg, getInboxAgg, invalidateInboxAgg, resetInboxAggCacheForTests } =
    await import("./inbox-agg.js");

const PROJECT = "p2159";
const OTHER_PROJECT = "p2159-other";
const HUMAN = "david";
const AGENT = "claude-aiball-dev";

const db = getDb();
createProject({ name: PROJECT });
createProject({ name: OTHER_PROJECT });

let seq = 0;

function mkTicket(id: number, project = PROJECT) {
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title: `T${id}`, status: "approved",
        byAgent: HUMAN, lastActor: HUMAN, lastActorAt: nowIso(), createdAt: nowIso(),
    }).run();
}

function msg(ticketId: number, kind: string, opts: { status?: string; meta?: string; body?: string } = {}) {
    const id = 80000 + ++seq;
    db.insert(schema.messages).values({
        id, ticketId, kind,
        status: opts.status ?? "approved",
        body: opts.body ?? (kind === "comment_added" ? "text" : null),
        meta: opts.meta ?? null,
        byAgent: AGENT, displaySeq: ++seq, createdAt: nowIso(),
    }).run();
    return id;
}

// #1 carries every shape the fold handles; #2 and #3 are the neighbours that a
// repair must NOT disturb, one of them in another project.
mkTicket(1); mkTicket(2); mkTicket(3, OTHER_PROJECT);
msg(1, "comment_added");
msg(1, "comment_added", { status: "pending" });
msg(1, "comment_added", { meta: JSON.stringify({ decision: { kind: "plan", status: "pending" } }) });
msg(1, "ticket_closed", { body: "closing" });
msg(1, "ticket_reopened", { body: "reopening" });
msg(2, "comment_added");
msg(3, "comment_added");

/** The entry a full, cold rebuild would produce. */
const rebuilt = (project: string | undefined, id: number) => buildInboxAgg(project).get(id);

test("a repaired entry equals a rebuilt one, in BOTH cached maps", () => {
    resetInboxAggCacheForTests();
    getInboxAgg(PROJECT);       // warm the project map
    getInboxAgg(undefined);     // and the cross-project one

    msg(1, "comment_added");    // the write
    invalidateInboxAgg(PROJECT, 1);

    assert.deepEqual(getInboxAgg(PROJECT).get(1), rebuilt(PROJECT, 1), "project map");
    assert.deepEqual(getInboxAgg(undefined).get(1), rebuilt(undefined, 1), "cross-project map");
});

test("the repair leaves the neighbours alone — that is the whole point", () => {
    resetInboxAggCacheForTests();
    const before2 = { ...getInboxAgg(PROJECT).get(2)! };
    getInboxAgg(undefined);
    const before3 = { ...getInboxAgg(undefined).get(3)! };

    msg(1, "comment_added");
    invalidateInboxAgg(PROJECT, 1);

    assert.deepEqual(getInboxAgg(PROJECT).get(2), before2, "same project, untouched");
    assert.deepEqual(getInboxAgg(undefined).get(3), before3, "other project, untouched");
});

test("a lifecycle write repairs closed/resolved, not just the counts", () => {
    resetInboxAggCacheForTests();
    getInboxAgg(PROJECT);
    assert.equal(getInboxAgg(PROJECT).get(1)!.closed, false, "precondition: reopened");

    msg(1, "ticket_closed", { body: "closing again" });
    invalidateInboxAgg(PROJECT, 1);

    assert.equal(getInboxAgg(PROJECT).get(1)!.closed, true);
    assert.deepEqual(getInboxAgg(PROJECT).get(1), rebuilt(PROJECT, 1));
});

test("a ticket whose last message goes away leaves the map, like a rebuild", () => {
    // The fold only creates an entry for a thread that HAS a non-ticket_created
    // message. A repair that wrote an empty agg instead of removing the key
    // would leave a phantom row a full rebuild does not have.
    resetInboxAggCacheForTests();
    mkTicket(4);
    const only = msg(4, "comment_added");
    invalidateInboxAgg(PROJECT, 4);
    assert.equal(getInboxAgg(PROJECT).has(4), true, "precondition: present");

    db.delete(schema.messages).where(eq(schema.messages.id, only)).run();
    invalidateInboxAgg(PROJECT, 4);

    assert.equal(getInboxAgg(PROJECT).has(4), false);
    assert.equal(rebuilt(PROJECT, 4), undefined, "and a rebuild agrees");
});

test("an uncached map is left alone rather than seeded from one ticket", () => {
    resetInboxAggCacheForTests();
    invalidateInboxAgg(PROJECT, 1);
    // Nothing was cached, so nothing was repaired — the next read must be a
    // full, correct build rather than a map holding a single entry.
    const agg = getInboxAgg(PROJECT);
    assert.equal(agg.has(1), true);
    assert.equal(agg.has(2), true, "a partial map would be missing this");
});

after(() => {
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});
