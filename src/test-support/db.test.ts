// #324 slice 1 — proves the isolated test DB + counter-divergence: a comment
// posted right after its ticket reads back as `comment_added` (not misresolved
// to `ticket_created` via the fresh-DB id-counter collision).
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedTestDb } from "./db.js";
import { submitMessage } from "../messages.js";

test("test DB: isolated + counter-divergence keeps a comment a comment_added", () => {
    seedTestDb();
    const t = submitMessage({ project: "tp", kind: "ticket_created", title: "x", by_agent: "a" } as never) as { id: number; ticket_id: number | null; kind: string };
    const tid = t.ticket_id ?? t.id;
    const c = submitMessage({ project: "tp", kind: "comment_added", ticket_id: tid, body: "hi", by_agent: "a" } as never) as { id: number; kind: string };
    assert.equal(t.kind, "ticket_created");
    assert.equal(c.kind, "comment_added"); // would be "ticket_created" on a fresh DB without the divergence
    assert.notEqual(c.id, tid);
});
