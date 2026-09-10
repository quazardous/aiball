// #2199 — `drained_parent`: an open ticket with nothing still moving under it.
//
// The mirror of `orphan_child`. What must hold: the walk goes all the way down
// (an open grandchild under a closed child keeps the parent off the list), a
// single open child is enough to keep it off, a ticket with no children or
// already closed is never reported, a held parent says who holds it, a lineage
// cycle cannot hang the walk — and, like every finding, the audit writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2199-"));
process.env.AIBALL_SOCK = "";

const { sql } = await import("drizzle-orm");
const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { insertTypedRelation } = await import("./messages.js");
const { graphAudit } = await import("./graph-query.js");

const db = getDb();
const ACTOR = "claude-aiball-dev";
createProject({ name: "alpha" });

const ticket = (id: number, title: string, claimant: string | null = null) =>
    db.insert(schema.tickets).values({
        id, project: "alpha", displaySeq: id, title, body: "",
        status: "approved", byAgent: ACTOR, createdAt: "2026-09-01T10:00:00.000Z", claimant,
    }).run();
const childOf = (child: number, parent: number) =>
    insertTypedRelation({ source_ticket_id: child, target_ticket_id: parent, relation_kind: "child_of", by_agent: ACTOR });

// Relations FIRST: insertTypedRelation allocates the next message id itself, and
// the closures below use a fixed high range, so interleaving them would collide.
ticket(100, "umbrella, all done");      // A — drained, three levels
ticket(101, "done");
ticket(102, "done, with a child");
ticket(103, "done grandchild");
childOf(101, 100); childOf(102, 100); childOf(103, 102);

ticket(110, "umbrella, grandchild alive"); // B — open grandchild under a closed child
ticket(111, "done child");
ticket(112, "open grandchild");
childOf(111, 110); childOf(112, 111);

ticket(120, "umbrella, child alive");   // C — open direct child
ticket(121, "open child");
childOf(121, 120);

ticket(130, "no children");              // D
ticket(140, "closed parent");            // E — closed parent, closed child
ticket(141, "closed child");
childOf(141, 140);

ticket(150, "held umbrella", "someone"); // F — drained, but held
ticket(151, "done");
childOf(151, 150);

ticket(160, "cycle a");                   // G — lineage cycle, must terminate
ticket(161, "cycle b");
childOf(161, 160); childOf(160, 161);

let nextMsg = 5_000_001;
const close = (ticketId: number) =>
    db.insert(schema.messages).values({
        id: nextMsg++, ticketId, kind: "ticket_closed", body: "", byAgent: ACTOR, status: "approved",
        createdAt: "2026-09-01T11:00:00.000Z", displaySeq: nextMsg,
    }).run();
for (const id of [101, 102, 103, 111, 140, 141, 151, 161]) close(id);

const drained = () => graphAudit().findings.filter((f) => f.kind === "drained_parent");
const about = (id: number) => drained().find((f) => f.ticket_ids[0] === id);

test("an open parent with nothing moving below it, all the way down, is a candidate", () => {
    const f = about(100);
    assert.ok(f, "#100 is reported");
    assert.deepEqual([...f.ticket_ids].sort((a, b) => a - b), [100, 101, 102], "the parent, then its direct children");
    assert.match(f.detail, /all 3 tickets below it are closed/);
    assert.equal(f.citation, null, "typed relations carry no prose to cite");
});

test("an open grandchild keeps its parent off the list, even under a closed child", () => {
    assert.equal(about(110), undefined);
});

test("one open direct child is enough to keep the parent off the list", () => {
    assert.equal(about(120), undefined);
});

test("a ticket with no children, or a closed parent, is never reported", () => {
    assert.equal(about(130), undefined);
    assert.equal(about(140), undefined);
});

test("a drained parent says who holds it instead of being hidden", () => {
    const f = about(150);
    assert.ok(f);
    assert.deepEqual(f.held_by, { claimant: "someone" });
    assert.match(f.detail, /held by someone/);
});

test("a lineage cycle does not hang the walk, and nothing is reported twice", () => {
    const ids = drained().map((f) => f.ticket_ids[0]);
    assert.equal(ids.length, new Set(ids).size);
});

test("the audit writes nothing — it reports candidates, it does not act", () => {
    const count = () => db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _messages`)[0].n;
    const before = count();
    graphAudit();
    assert.equal(count(), before);
});
