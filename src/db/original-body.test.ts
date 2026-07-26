// #1565 — `title`/`body` hold the CURRENT text; `original_*` keeps the pre-edit
// archive, written at the FIRST edit only (first + last, no intermediate
// versions). The interesting case is the SECOND edit: it must move `body` again
// while leaving the archive alone.
//
// Running against a throwaway AIBALL_HOME also proves migration 0056 applies
// cleanly to a fresh DB, not just to the live one it was tested on.
//
// Run: `npx tsx --test src/db/original-body.test.ts`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1565-"));

const { editMessage } = await import("./messages.js");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { eq, sql } = await import("drizzle-orm");

const db = getDb();

let seq = 0;

function newTicket(title: string, body: string): number {
    const r = db.insert(schema.tickets)
        .values({ project: "p", displaySeq: ++seq, title, body, createdAt: nowIso() })
        .returning({ id: schema.tickets.id })
        .get();
    return r.id;
}

function ticketRow(id: number) {
    return db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()!;
}

test("the migrated schema has original_* and no longer has edited_*", () => {
    const cols = db.all<{ name: string }>(sql`select name from pragma_table_info('tickets')`)
        .map((r) => r.name);
    assert.ok(cols.includes("original_title"), "original_title must exist");
    assert.ok(cols.includes("original_body"), "original_body must exist");
    assert.ok(!cols.includes("edited_title"), "edited_title must be gone");
    assert.ok(!cols.includes("edited_body"), "edited_body must be gone");
});

test("a never-edited ticket keeps a NULL archive — it is not a systematic copy", () => {
    const id = newTicket("untouched", "as filed");
    const t = ticketRow(id);
    assert.equal(t.title, "untouched");
    assert.equal(t.originalTitle, null);
    assert.equal(t.originalBody, null);
});

test("first edit: body/title move to the new text, the old text lands in original_*", () => {
    const id = newTicket("v1 title", "v1 body");
    editMessage(id, { title: "v2 title", body: "v2 body" });
    const t = ticketRow(id);
    assert.equal(t.title, "v2 title", "title must carry the CURRENT text");
    assert.equal(t.body, "v2 body");
    assert.equal(t.originalTitle, "v1 title", "the archive takes the pre-edit text");
    assert.equal(t.originalBody, "v1 body");
});

test("second edit: the archive still holds v1 — first + last, never the middle", () => {
    const id = newTicket("v1 title", "v1 body");
    editMessage(id, { title: "v2 title", body: "v2 body" });
    editMessage(id, { title: "v3 title", body: "v3 body" });
    const t = ticketRow(id);
    assert.equal(t.title, "v3 title");
    assert.equal(t.body, "v3 body");
    assert.equal(t.originalTitle, "v1 title", "v2 must NOT have overwritten the archive");
    assert.equal(t.originalBody, "v1 body");
});

test("editing only the body leaves original_title NULL (per-field, not per-edit)", () => {
    const id = newTicket("kept", "v1 body");
    editMessage(id, { body: "v2 body" });
    const t = ticketRow(id);
    assert.equal(t.title, "kept");
    assert.equal(t.originalTitle, null, "an untouched title has nothing to archive");
    assert.equal(t.originalBody, "v1 body");
});

test("comments follow the same rule on _messages", () => {
    const ticketId = newTicket("host", "host body");
    // Comment ids live above 1_000_000 (migration 0007 split the counters) and
    // editMessage relies on that: it tries `tickets` first and falls through
    // only because the two id spaces are disjoint. Allocating a low id here
    // would make the ticket UPDATE match a real ticket instead.
    const id = 1_000_001;
    db.insert(schema.messages).values({
        id, ticketId, displaySeq: 1, kind: "comment_added",
        body: "comment v1", createdAt: nowIso(),
    }).run();

    editMessage(id, { body: "comment v2" });
    editMessage(id, { body: "comment v3" });

    const m = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
    assert.equal(m.body, "comment v3", "the comment reads as its current text");
    assert.equal(m.originalBody, "comment v1", "archive pinned to the first version");
});

after(() => {
    try {
        rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true });
    } catch {
        /* best-effort temp cleanup */
    }
});
