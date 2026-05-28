/**
 * #568 — closing a ticket releases its claim (focus) but KEEPS its
 * assignment (responsibility). Verify the new contract end-to-end :
 * a ticket with both an assignee and a claimant ends up `assignee
 * intact, claimant cleared` after a close lands.
 *
 * Setup mirrors `src/automation/runtime.test.ts` — throwaway DB
 * pointed at via `AIBALL_HOME` before any module import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-568-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject, getProject } = await import("./db/projects.js");
const { setTicketAssignment, setTicketClaim } = await import("./db/tickets.js");
const { getMessage } = await import("./db/messages.js");

getDb();
createProject({ name: "p568" });
upsertConsumer({ consumer_id: "human-david", kind: "human" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent" });

test("#568 — closing a ticket clears the claim but keeps the assignment", () => {
    // Create + auto-approve the ticket (human reporter bypasses moderation).
    const t = submitMessage({
        project: "p568",
        kind: "ticket_created",
        title: "subject",
        body: "body",
        by_agent: "human-david",
    });
    assert.equal(t.status, "approved");

    // Apply both holds : assigned to agent-x AND claimed by agent-x.
    setTicketAssignment(t.id, "agent-x", "human-david");
    setTicketClaim(t.id, "agent-x");

    const before = getMessage(t.id);
    assert.equal(before?.assignee, "agent-x", "pre-close : assignee set");
    assert.equal(before?.claimant, "agent-x", "pre-close : claimant set");

    // Reporter closes the ticket — owner-bypass auto-approves.
    submitMessage({
        project: "p568",
        kind: "ticket_closed",
        ticket_id: t.id,
        by_agent: "human-david",
    });

    const after = getMessage(t.id);
    assert.equal(after?.claimant, null, "post-close : claim released (focus transient)");
    assert.equal(after?.claimed_at, null, "post-close : claimed_at cleared");
    assert.equal(
        after?.assignee,
        "agent-x",
        "post-close : assignment PRESERVED (responsibility persistent, #568)",
    );
    assert.equal(
        after?.assigned_by,
        "human-david",
        "post-close : assigned_by preserved for audit",
    );

    // Sanity : project still exists, in case the close had nuked it.
    assert.ok(getProject("p568"));
});
