// #2194 — `intra_project_open_pair`: two open tickets of the SAME project that
// keep naming each other with no typed relation. What must hold: the weight
// threshold (5, both directions summed) is what decides, a typed relation of
// any kind or a closed side keeps the pair off, each pair appears once, and the
// cross-project finding next to it is left exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2194-"));
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
createProject({ name: "beta" });

// Ids from 110 up: the mention extractor ignores references below #100
// (MIN_TICKET_REF), so a fixture with two-digit ids compiles an empty graph and
// every "is reported" assertion fails for a reason that has nothing to do with
// the finding under test.
const ticket = (id: number, project: string, title: string) =>
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title, body: "",
        status: "approved", byAgent: ACTOR, createdAt: "2026-09-01T10:00:00.000Z",
    }).run();

ticket(110, "alpha", "heavy a"); ticket(111, "alpha", "heavy b");           // 3 + 2 = 5 → reported
ticket(120, "alpha", "light a"); ticket(121, "alpha", "light b");           // 2 + 2 = 4 → below threshold
ticket(130, "alpha", "typed a"); ticket(131, "alpha", "typed b");           // 5, but related
ticket(140, "alpha", "closed a"); ticket(141, "alpha", "closed b");         // 5, but one side closed
ticket(150, "alpha", "across a"); ticket(151, "beta", "across b");          // 3 + 2, different projects
ticket(160, "alpha", "one-sided a"); ticket(161, "alpha", "one-sided b");   // 5 + 0 → reported

// The typed relation FIRST: it allocates its own message id, and the comments
// below use a fixed high range that would otherwise collide with it.
insertTypedRelation({ source_ticket_id: 130, target_ticket_id: 131, relation_kind: "relates_to", by_agent: ACTOR });

let nextMsg = 5_000_001;
// The thread's next slot comes from the database, not from a local counter: the
// typed relation above already took slot 1 on #130, and a counter starting at 1
// collides with it on (ticket_id, display_seq).
const say = (ticketId: number, body: string, kind = "comment_added") => {
    const displaySeq = (db.get<{ n: number }>(
        sql`SELECT COALESCE(MAX(display_seq), 0) + 1 AS n FROM _messages WHERE ticket_id = ${ticketId}`,
    )?.n) ?? 1;
    db.insert(schema.messages).values({
        id: nextMsg++, ticketId, kind, body, byAgent: ACTOR, status: "approved",
        createdAt: "2026-09-01T11:00:00.000Z", displaySeq,
    }).run();
};
/** `from` names `to` in `n` separate comments. */
const names = (from: number, to: number, n: number) => { for (let i = 0; i < n; i++) say(from, `see #${to}`); };

names(110, 111, 3); names(111, 110, 2);
names(120, 121, 2); names(121, 120, 2);
names(130, 131, 3); names(131, 130, 2);
names(140, 141, 3); names(141, 140, 2);
names(150, 151, 3); names(151, 150, 2);
names(160, 161, 5);
say(141, "", "ticket_closed");

const findings = () => graphAudit().findings;
const intra = () => findings().filter((f) => f.kind === "intra_project_open_pair");
const pair = (f: { ticket_ids: number[] }) => [...f.ticket_ids].sort((a, b) => a - b).join(":");

test("two open tickets of one project naming each other 5 times, untyped, are a candidate", () => {
    const f = intra().find((x) => pair(x) === "110:111");
    assert.ok(f, "110 ↔ 111 is reported");
    assert.match(f.detail, /both open in alpha, naming each other 5 times, with no typed relation/);
    assert.ok(f.citation, "a pair read from prose carries its citation");
});

test("below the threshold the pair stays off the report", () => {
    assert.equal(intra().some((x) => pair(x) === "120:121"), false);
});

test("a typed relation of any kind keeps the pair off", () => {
    assert.equal(intra().some((x) => pair(x) === "130:131"), false);
});

test("a pair with a closed side is not an open pair", () => {
    assert.equal(intra().some((x) => pair(x) === "140:141"), false);
});

test("one side naming the other five times is enough", () => {
    assert.ok(intra().some((x) => pair(x) === "160:161"));
});

test("each pair is reported once, heaviest first", () => {
    const pairs = intra().map(pair);
    assert.equal(pairs.length, new Set(pairs).size);
    assert.deepEqual(pairs, ["110:111", "160:161"], "equal weights fall back to a stable order");
});

test("the cross-project finding is unchanged, and never duplicated as intra", () => {
    const cross = findings().filter((f) => f.kind === "cross_project_open_pair").map(pair);
    assert.deepEqual(cross, ["150:151"]);
    assert.equal(intra().some((x) => pair(x) === "150:151"), false);
});
