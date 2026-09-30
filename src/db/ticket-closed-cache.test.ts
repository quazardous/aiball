/**
 * #3405 — the board's closed tickets are kept between two writes: a close and
 * a reopen are seen by the very next reader, and a reader cannot spoil the
 * copy the others get.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3405-closed-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { submitMessage } = await import("../messages.js");
const { allClosedTicketIds } = await import("./ticket-closed.js");
const { buildBacklogRulesCtx } = await import("./backlog-rules.js");

test("a close and a reopen are read at the next read, by the rules too", () => {
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    upsertConsumer({ consumer_id: "worker", kind: "agent" });
    createProject({ name: "closing" });
    const t = submitMessage({ project: "closing", kind: "ticket_created", title: "a ticket", body: "b", by_agent: "boss" });
    assert.equal(allClosedTicketIds().has(t.id), false);
    submitMessage({ project: "closing", kind: "ticket_closed", ticket_id: t.id, parent_id: t.id, by_agent: "boss" });
    assert.equal(allClosedTicketIds().has(t.id), true, "closed");
    assert.equal(buildBacklogRulesCtx("worker").closedIds.has(t.id), true, "the wake rules read the same set");
    submitMessage({ project: "closing", kind: "ticket_reopened", ticket_id: t.id, parent_id: t.id, by_agent: "boss" });
    assert.equal(allClosedTicketIds().has(t.id), false, "reopened");
});

test("each reader gets its own copy", () => {
    const mine = allClosedTicketIds();
    mine.add(999_999);
    assert.equal(allClosedTicketIds().has(999_999), false);
});
