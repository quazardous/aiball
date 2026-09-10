// #2208 — drift against objectives. What must hold: a drained parent that is a
// `steering` ticket reads as `steering_drained` (other parents keep
// `drained_parent`); open `work` serving no objective is reported only inside a
// project that has an open steering ticket, anchoring walks up through closed
// intermediates, and a project reports its oldest ten with the total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2208-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { insertTypedRelation } = await import("./messages.js");
const { graphAudit } = await import("./graph-query.js");

const db = getDb();
const ACTOR = "claude-aiball-dev";
for (const name of ["alpha", "beta", "gamma", "delta"]) createProject({ name });

const ticket = (id: number, project: string, level: "work" | "steering" = "work") =>
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title: `t${id}`, body: "", level,
        status: "approved", byAgent: ACTOR, createdAt: "2026-09-01T10:00:00.000Z",
    }).run();
const childOf = (child: number, parent: number) =>
    insertTypedRelation({ source_ticket_id: child, target_ticket_id: parent, relation_kind: "child_of", by_agent: ACTOR });

// alpha — has an open objective
ticket(110, "alpha", "steering");            // the objective
ticket(111, "alpha"); childOf(111, 110);     // anchored directly
ticket(112, "alpha");                         // serves nothing
ticket(113, "alpha"); childOf(113, 110);     // closed epic under the objective
ticket(114, "alpha"); childOf(114, 113);     // anchored THROUGH the closed epic
ticket(115, "alpha", "steering");            // an objective whose work all closed
ticket(116, "alpha"); childOf(116, 115);
ticket(117, "alpha");                         // an ordinary parent whose work all closed
ticket(118, "alpha"); childOf(118, 117);
// beta — no objective at all
ticket(120, "beta");
// gamma — only a CLOSED objective
ticket(130, "gamma", "steering");
ticket(131, "gamma");
// delta — one objective, twelve tickets serving none of it
ticket(140, "delta", "steering");
for (let id = 141; id <= 152; id++) ticket(id, "delta");

// Closures last: the relations above allocate their own message ids.
let nextMsg = 5_000_001;
for (const id of [113, 116, 118, 130]) {
    db.insert(schema.messages).values({
        id: nextMsg++, ticketId: id, kind: "ticket_closed", body: "", byAgent: ACTOR, status: "approved",
        createdAt: "2026-09-01T11:00:00.000Z", displaySeq: nextMsg,
    }).run();
}

const findings = () => graphAudit().findings;
const ofKind = (kind: string) => findings().filter((f) => f.kind === kind);
const firstIds = (kind: string) => ofKind(kind).map((f) => f.ticket_ids[0]);

test("a drained objective reads as steering_drained; an ordinary drained parent keeps drained_parent", () => {
    assert.ok(firstIds("steering_drained").includes(115));
    assert.equal(firstIds("drained_parent").includes(115), false, "no duplicate under the old kind");
    assert.ok(firstIds("drained_parent").includes(117));
    const f = ofKind("steering_drained").find((x) => x.ticket_ids[0] === 115);
    assert.match(f?.detail ?? "", /^an objective with nothing moving under it: all 1 ticket below it are closed/);
});

test("inside a project with an open objective, work that serves none of it is reported", () => {
    const ids = firstIds("unanchored_work");
    assert.ok(ids.includes(112), "112 serves nothing");
    assert.equal(ids.includes(111), false, "111 is under the objective");
    assert.equal(ids.includes(110), false, "an objective is not work");
    assert.equal(ids.includes(115), false, "an objective is not work");
});

test("anchoring walks up through a closed intermediate", () => {
    assert.equal(firstIds("unanchored_work").includes(114), false);
});

test("where there is no open objective, the question is not asked", () => {
    const ids = firstIds("unanchored_work");
    assert.equal(ids.includes(120), false, "beta has no objective");
    assert.equal(ids.includes(131), false, "gamma's only objective is closed");
});

test("a project reports its ten oldest unanchored tickets, and says how many there are", () => {
    const delta = ofKind("unanchored_work").filter((f) => f.detail.includes("in delta"));
    assert.deepEqual(delta.map((f) => f.ticket_ids[0]), [141, 142, 143, 144, 145, 146, 147, 148, 149, 150]);
    assert.match(delta[0].detail, /12 such tickets in delta, oldest 10 shown/);
});
