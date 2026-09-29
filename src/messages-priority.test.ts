/**
 * #1156 (runic post-mortem #1155) — `priority` on `ticket_new` was accepted by
 * the MCP schema but unknown to `validateNewMessage` → dropped SILENTLY, and
 * the SQL default applied. The fix mirrors the `intent` handling: validated
 * when present (400 on an unknown value, no silent drop), forwarded on
 * ticket_created, nulled elsewhere.
 *
 * Setup: throwaway DB via AIBALL_HOME before the imports (same pattern as
 * messages-decision-guard.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1156-"));

const { getDb } = await import("./db/connection.js");
const { eq } = await import("drizzle-orm");
const schema = await import("./schema.js");
const { submitMessage, validateNewMessage } = await import("./messages.js");
const { createProject } = await import("./db/projects.js");

getDb();
createProject({ name: "prio-test" });

test("#1156: priority forwarded by the validator on ticket_created", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "low ticket",
        priority: "low",
        by_agent: "agent-x",
    });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.equal(v.priority, "low");
});

test("#1156: invalid priority → explicit error (no silent drop)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "bad prio",
        priority: "asap",
    });
    assert.ok("error" in v);
    assert.match(v.error, /priority must be one of/);
});

test("#1156: missing priority → null (the SQL default applies downstream)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "no prio",
    });
    assert.ok(!("error" in v));
    assert.equal(v.priority, null);
});

test("#1156: priority on comment_added → nulled (tickets only, mirrors intent)", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "comment_added",
        ticket_id: 1,
        body: "x",
        priority: "high",
        by_agent: "human",
        summary_until: "s",
    });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.equal(v.priority, null);
});

test("#1156: end-to-end — the created ticket CARRIES the priority (the runic bug: 'low' became 'normal')", () => {
    const v = validateNewMessage({
        project: "prio-test",
        kind: "ticket_created",
        title: "e2e low",
        priority: "low",
        by_agent: "agent-x",
    });
    assert.ok(!("error" in v));
    const msg = submitMessage(v);
    const row = getDb().select({ priority: schema.tickets.priority })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, msg.id))
        .get();
    assert.equal(row?.priority, "low");
});
