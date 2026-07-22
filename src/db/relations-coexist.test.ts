// #1466 — a `depends_on` gate and a `parent_of` lineage edge to the SAME target
// must COEXIST (orthogonal axes), instead of the reciprocal lineage silently
// clobbering the direct gate (a created-but-invisible relation). Drives a real
// throwaway SQLite via listTypedRelationsForTicket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1466-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { insertTypedRelation, listTypedRelationsForTicket } = await import("./messages.js");

const db = getDb();
function seed(id: number): void {
    db.insert(schema.tickets).values({
        id,
        project: "sim-1466",
        displaySeq: id,
        title: `T${id}`,
        status: "approved",
        createdAt: nowIso(),
    }).run();
}
for (let i = 1; i <= 8; i++) seed(i);

test("reciprocal parent_of + direct depends_on to the same target COEXIST", () => {
    // child #2 is child_of parent #1 → #1 sees a reciprocal parent_of → #2.
    insertTypedRelation({ source_ticket_id: 2, target_ticket_id: 1, relation_kind: "child_of", by_agent: "a" });
    // #1 gates itself on the child: a direct depends_on #1 → #2.
    insertTypedRelation({ source_ticket_id: 1, target_ticket_id: 2, relation_kind: "depends_on", by_agent: "a" });

    const to2 = listTypedRelationsForTicket(1).filter((r) => r.target_ticket_id === 2);
    assert.equal(to2.length, 2, "both the lineage and the gate relation to #2 survive");
    assert.ok(to2.some((r) => r.kind === "parent_of" && r.reciprocal), "reciprocal parent_of still shown");
    assert.ok(to2.some((r) => r.kind === "depends_on" && !r.reciprocal), "direct depends_on no longer swallowed");
});

test("latest wins WITHIN an axis (blocks replaces a prior depends_on)", () => {
    insertTypedRelation({ source_ticket_id: 3, target_ticket_id: 4, relation_kind: "depends_on", by_agent: "a" });
    insertTypedRelation({ source_ticket_id: 3, target_ticket_id: 4, relation_kind: "blocks", by_agent: "a" });
    const to4 = listTypedRelationsForTicket(3).filter((r) => r.target_ticket_id === 4);
    assert.equal(to4.length, 1, "the gate axis holds a single relation");
    assert.equal(to4[0].kind, "blocks", "the later gate kind wins");
});

test("unrelate (ignored) cuts every axis to that target", () => {
    insertTypedRelation({ source_ticket_id: 5, target_ticket_id: 6, relation_kind: "parent_of", by_agent: "a" });
    insertTypedRelation({ source_ticket_id: 5, target_ticket_id: 6, relation_kind: "depends_on", by_agent: "a" });
    assert.equal(
        listTypedRelationsForTicket(5).filter((r) => r.target_ticket_id === 6).length,
        2,
        "lineage + gate coexist before the cut",
    );
    insertTypedRelation({ source_ticket_id: 5, target_ticket_id: 6, relation_kind: "ignored", by_agent: "a" });
    assert.equal(
        listTypedRelationsForTicket(5).filter((r) => r.target_ticket_id === 6).length,
        0,
        "the tombstone removes the link whatever its axis",
    );
});

test("a relation re-authored AFTER a cut survives it", () => {
    insertTypedRelation({ source_ticket_id: 7, target_ticket_id: 8, relation_kind: "depends_on", by_agent: "a" });
    insertTypedRelation({ source_ticket_id: 7, target_ticket_id: 8, relation_kind: "ignored", by_agent: "a" });
    insertTypedRelation({ source_ticket_id: 7, target_ticket_id: 8, relation_kind: "relates_to", by_agent: "a" });
    const to8 = listTypedRelationsForTicket(7).filter((r) => r.target_ticket_id === 8);
    assert.equal(to8.length, 1, "only the post-cut relation survives");
    assert.equal(to8[0].kind, "relates_to");
});
