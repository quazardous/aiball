/**
 * #586 — focused tests for the two close-time cleanup helpers extracted
 * from `submitMessage`. Setup mirrors `messages-close.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-586-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject } = await import("./db/projects.js");
const { getMessageByHashid, insertMessage } = await import("./db/messages.js");
const { autoApproveStaleDecisionsOnClose, rejectStaleClosedReopenedForTicket } =
    await import("./close-cleanup.js");

getDb();
createProject({ name: "p586" });
upsertConsumer({ consumer_id: "human-david", kind: "human" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent" });

test("autoApproveStaleDecisionsOnClose promotes pending ticket_resolved", () => {
    const t = submitMessage({
        project: "p586",
        kind: "ticket_created",
        title: "T-auto-approve",
        by_agent: "human-david",
    });
    // Inject a PENDING ticket_resolved directly via the DB layer (submitMessage
    // would route it through the rule engine and likely auto-approve, hiding
    // the helper's effect).
    const resolved = insertMessage({
        project: "p586",
        kind: "ticket_resolved",
        ticket_id: t.id,
        by_agent: "agent-x",
    });
    assert.equal(resolved.status, "pending", "precondition: ticket_resolved is pending");

    autoApproveStaleDecisionsOnClose(t.id, "human-david");

    // Use hashid lookup to avoid the tickets.id × messages.id collision (#568).
    const after = getMessageByHashid(resolved.hashid!);
    assert.equal(after?.status, "approved", "ticket_resolved auto-approved on close");
});

test("rejectStaleClosedReopenedForTicket rejects pending closes except the excluded one", () => {
    const t = submitMessage({
        project: "p586",
        kind: "ticket_created",
        title: "T-reject-stale",
        by_agent: "human-david",
    });
    // Inject two pending ticket_closed rows directly (submitMessage would
    // reject a non-reporter close via assertCloseAuthority).
    const close1 = insertMessage({
        project: "p586",
        kind: "ticket_closed",
        ticket_id: t.id,
        by_agent: "agent-x",
    });
    const close2 = insertMessage({
        project: "p586",
        kind: "ticket_closed",
        ticket_id: t.id,
        by_agent: "agent-x",
    });
    assert.equal(close1.status, "pending");
    assert.equal(close2.status, "pending");

    // Pretend close2 is the just-approved lifecycle row; close1 should be rejected.
    rejectStaleClosedReopenedForTicket(t.id, close2.id);

    // Use hashid lookup to avoid the tickets.id × messages.id collision (#568).
    const c1 = getMessageByHashid(close1.hashid!);
    const c2 = getMessageByHashid(close2.hashid!);
    assert.equal(c1?.status, "rejected", "stale close auto-rejected");
    assert.equal(c2?.status, "pending", "excluded close unchanged");
});

test("rejectStaleClosedReopenedForTicket also rejects pending ticket_reopened", () => {
    const t = submitMessage({
        project: "p586",
        kind: "ticket_created",
        title: "T-reject-reopen",
        by_agent: "human-david",
    });
    const reopen = insertMessage({
        project: "p586",
        kind: "ticket_reopened",
        ticket_id: t.id,
        by_agent: "agent-x",
    });
    assert.equal(reopen.status, "pending");

    rejectStaleClosedReopenedForTicket(t.id, -1); // no exclusion

    const after = getMessageByHashid(reopen.hashid!);
    assert.equal(after?.status, "rejected", "stale reopen also auto-rejected");
});
