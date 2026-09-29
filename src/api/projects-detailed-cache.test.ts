/**
 * #2682 — listProjectsDetailed builds its consumer-independent base once for
 * every caller, dropped on every write that invalidates the flags cache: counts
 * never lag a write.
 * `project` narrows the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2682-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, listProjectsDetailed } = await import("../db/projects.js");
const { upsertConsumer } = await import("../db.js");
const { updateMessageStatus } = await import("../db/messages.js");
const schema = await import("../schema.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "pa" });
createProject({ name: "pb" });

test("one base serves every consumer, and a write refreshes it at once", () => {
    const now = Date.now();
    const t = submitMessage({ project: "pa", kind: "ticket_created", title: "t", body: "x", by_agent: "boss" });
    const open = (rows: { name: string; open_count?: number }[]) => rows.find((p) => p.name === "pa")?.open_count;
    assert.equal(open(listProjectsDetailed("boss", false, now)), 1, "a human's ticket is open at once");
    // A write that bypasses invalidation: only a rebuild can see it.
    getDb().update(schema.tickets).set({ status: "pending" }).where(eq(schema.tickets.id, t.id)).run();
    assert.equal(open(listProjectsDetailed("boss", false, now + 1000)), 1, "served from memory within the ceiling");
    assert.equal(open(listProjectsDetailed("other", true, now + 1000)), 1, "another consumer reads the same base");
    assert.equal(open(listProjectsDetailed("boss", false, now + 1000 + 5000)), 0, "past the ceiling, rebuilt");

    const t2 = submitMessage({ project: "pa", kind: "ticket_created", title: "t2", body: "x", by_agent: "boss" });
    updateMessageStatus(t2.id, "approved", "human", null, "ticket_created");
    assert.equal(open(listProjectsDetailed("other", false, now + 1000 + 5000 + 1)), 1, "a write drops the base at once");
});

test("each call gets its own copy, with landscape only when asked", () => {
    const now = Date.now();
    const plain = listProjectsDetailed("boss", false, now);
    const pa = plain.find((p) => p.name === "pa")!;
    assert.equal(pa.landscape_hash, undefined);
    pa.open_count = 999;
    const withLandscape = listProjectsDetailed("boss", true, now + 1);
    const pa2 = withLandscape.find((p) => p.name === "pa")!;
    assert.notEqual(pa2.open_count, 999, "a caller mutating its answer does not corrupt the base");
    assert.equal(typeof pa2.landscape_hash, "string");
});

test("project.list narrows to one project with project", async () => {
    const { asToken } = await import("../tests/bus-call.js");
    const { issueToken } = await import("../db/tokens.js");
    const tok = issueToken({ kind: "agent", consumer_id: "boss", label: "2682" }).token;
    const rows = (await asToken<Array<{ name: string }>>(tok, "project.list", { detailed: true, project: "pb" })).json;
    assert.deepEqual(rows.map((p) => p.name), ["pb"]);
    const all = (await asToken<Array<{ name: string }>>(tok, "project.list", { detailed: true })).json;
    assert.ok(all.length >= 2);
});
