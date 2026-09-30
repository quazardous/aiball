/**
 * #3405 — the tickets mentioning a specialist are kept between two writes of
 * the board: a mention posted after a read is seen at the next read.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3405-mentions-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { submitMessage } = await import("../messages.js");
const { buildBacklogRulesCtx } = await import("./backlog-rules.js");

test("a mention posted after a read reaches the specialist at its next read", () => {
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    upsertConsumer({ consumer_id: "spec", kind: "agent" });
    createProject({ name: "mentions" });
    const t = submitMessage({ project: "mentions", kind: "ticket_created", title: "a ticket", body: "nobody named", by_agent: "boss" });
    const mine = () => buildBacklogRulesCtx("spec", { canClaim: false }).mentionsMeIds;
    assert.equal(mine().has(t.id), false, "not mentioned yet");
    assert.equal(mine().has(t.id), false, "asked twice: the same answer, kept");
    submitMessage({ project: "mentions", kind: "comment_added", ticket_id: t.id, parent_id: t.id, body: "over to @spec", by_agent: "boss" });
    assert.equal(mine().has(t.id), true, "the comment's write dropped what was kept");
    const other = submitMessage({ project: "mentions", kind: "ticket_created", title: "another", body: "for @spec too", by_agent: "boss" });
    assert.equal(mine().has(other.id), true, "a new ticket's body too");
});
