// #1992 — the compiler, against a real (temporary) DB.
//
// What these pin, beyond "it produces edges": the CITATION. Every edge has to
// point back at the sentence that caused it, because a wrong edge is invisible
// in a way a missing edge is not — so an edge nobody can trace is not allowed
// to exist, and that is a property of the compiler, not of the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1992-"));

const { sql } = await import("drizzle-orm");
const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { compileGraph, ensureGraphFresh, readGraphVersion, MENTION_KIND } = await import("./graph-compile.js");

const PROJECT = "p1992";
const ACTOR = "claude-aiball-dev";
const db = getDb();
createProject({ name: PROJECT });

// Migration #0007 partitions the id ranges: tickets < 1_000_000, comments above.
const ticket = (id: number, title: string, body = "") =>
    db.insert(schema.tickets).values({
        id, project: PROJECT, displaySeq: id, title, body,
        status: "approved", byAgent: ACTOR, createdAt: "2026-09-01T10:00:00.000Z",
    }).run();

let nextMsg = 1_000_001;
/** display_seq is unique per ticket, so it counts per thread, not globally. */
const seqOf = new Map<number, number>();
const comment = (ticketId: number, body: string, status = "approved") => {
    const id = nextMsg++;
    const displaySeq = (seqOf.get(ticketId) ?? 0) + 1;
    seqOf.set(ticketId, displaySeq);
    db.insert(schema.messages).values({
        id, ticketId, kind: "comment_added", body, byAgent: ACTOR, status,
        createdAt: "2026-09-01T11:00:00.000Z", displaySeq,
    }).run();
    return id;
};

ticket(500, "the referenced one");
ticket(501, "the referring one", "context, see #500 for the background");
ticket(502, "a third");
const C_LINK = comment(502, "this is blocked by #500, same cause as before");
comment(502, "still #500 — confirmed twice", "approved");
comment(502, "and #501 too", "pending"); // not part of the record yet
comment(502, "compare with #999999 which does not exist");
comment(502, "a self reference #502 is not an edge");

const edges = () => db.all<{
    src_ticket_id: number; dst_ticket_id: number; weight: number;
    derived_message_id: number | null; derived_offset: number;
}>(
    sql`SELECT * FROM graph_edges WHERE kind = ${MENTION_KIND} ORDER BY src_ticket_id, dst_ticket_id`,
);

test("a comment's reference becomes an edge that cites the comment", () => {
    compileGraph(db);
    const e = edges().find((r) => r.src_ticket_id === 502 && r.dst_ticket_id === 500);
    assert.ok(e, "502 → 500 must exist");
    assert.equal(e.derived_message_id, C_LINK, "the citation names the comment it was read from");
    assert.equal(e.derived_offset, "this is blocked by ".length, "…and lands on the `#`");
});

test("repeats add weight — once is decoration, twice is a link", () => {
    const e = edges().find((r) => r.src_ticket_id === 502 && r.dst_ticket_id === 500);
    assert.equal(e?.weight, 2, "two approved comments name #500");
});

test("a reference in the ticket's own body cites no message", () => {
    const e = edges().find((r) => r.src_ticket_id === 501 && r.dst_ticket_id === 500);
    assert.ok(e, "501 → 500 comes from the body");
    assert.equal(e.derived_message_id, null, "src_ticket_id already names the source");
});

test("a pending comment is not part of the record", () => {
    assert.equal(edges().some((r) => r.src_ticket_id === 502 && r.dst_ticket_id === 501), false);
});

test("a reference to no ticket, and a self-reference, are not edges", () => {
    assert.equal(edges().some((r) => r.dst_ticket_id === 999999), false);
    assert.equal(edges().some((r) => r.src_ticket_id === r.dst_ticket_id), false);
});

test("a second compile is idempotent — it rebuilds, it does not accumulate", () => {
    const before = edges().length;
    compileGraph(db);
    assert.equal(edges().length, before);
});

test("ensureGraphFresh skips the work when the log has not moved", () => {
    compileGraph(db);
    const res = ensureGraphFresh(db);
    assert.equal(res.compiled, false, "nothing moved → no rebuild");
    assert.equal(res.ms, 0);
});

test("ensureGraphFresh rebuilds after a new message, and reports the drift", () => {
    const before = readGraphVersion(db).throughId;
    comment(501, "actually this also touches #502");
    const res = ensureGraphFresh(db);
    assert.equal(res.compiled, true);
    assert.ok(res.drift >= 1, `drift should count the new event, got ${res.drift}`);
    assert.ok(readGraphVersion(db).throughId > before);
    assert.ok(
        edges().some((r) => r.src_ticket_id === 501 && r.dst_ticket_id === 502),
        "the new edge is visible without anyone asking for a rebuild",
    );
});
