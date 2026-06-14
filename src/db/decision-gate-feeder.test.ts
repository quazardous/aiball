/**
 * #961 — integration tests for `decisionGateByTicket()` (the impure
 * feeder around the pure `computeDecisionGate`). The bug : the feeder
 * read `_messages` only and filtered `kind IN (..., "ticket_created")`,
 * but `ticket_created` is a VIRTUAL kind synthesized from the `tickets`
 * table — `_messages` never carries such rows. A `ticket_new({then:"plan"})`
 * therefore had its pending plan invisible to the gate, so the ticket
 * landed in the actionable / HOT pool of its own author.
 *
 * Pure replay tests live in `decision-gate.test.ts` ; this file covers
 * the SQL wiring : tickets-table meta IS read and merged in id-asc
 * order with `_messages` rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-961-"));

const { getDb } = await import("./connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("./messages.js");
const { upsertConsumer } = await import("./consumers.js");
const { createProject, decisionGateByTicket } = await import("./projects.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

getDb();
createProject({ name: "p961" });
upsertConsumer({ consumer_id: "david", kind: "human" });
upsertConsumer({ consumer_id: "claude-aiball-dev", kind: "agent" });

function newApprovedTicket(opts: { decision_kind?: "plan" } = {}): number {
    const t = submitMessage({
        project: "p961",
        kind: "ticket_created",
        title: "fixture",
        body: "test",
        by_agent: "claude-aiball-dev",
        ...(opts.decision_kind ? { decision_kind: opts.decision_kind } : {}),
    });
    if (t.status !== "approved") {
        updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    }
    return t.id;
}

test("ticket_new({then:'plan'}) → gate sees pending plan from tickets.meta (#961 fix)", () => {
    const id = newApprovedTicket({ decision_kind: "plan" });
    const gate = decisionGateByTicket();
    assert.equal(gate.get(id), true, "self-authored ticket with pending plan must be gated");
});

test("ticket_new without decision → no gate entry", () => {
    const id = newApprovedTicket();
    const gate = decisionGateByTicket();
    assert.equal(
        gate.get(id) ?? false,
        false,
        "plain ticket carries no decision → no gate entry",
    );
});

test("ticket_new({then:'plan'}) then meta flipped to accepted → un-gated (go-signal)", () => {
    const id = newApprovedTicket({ decision_kind: "plan" });
    // Mirror /decide HTTP : flip tickets.meta in place.
    getDb().update(schema.tickets)
        .set({ meta: JSON.stringify({ decision: { kind: "plan", status: "accepted" } }) })
        .where(eq(schema.tickets.id, id))
        .run();
    const gate = decisionGateByTicket();
    assert.equal(gate.get(id), false, "accepted plan = go-signal → un-gated");
});

test("merge order : ticket_created pending + later comment_added accepted → un-gated (id-asc replay)", () => {
    const id = newApprovedTicket({ decision_kind: "plan" });
    const c = submitMessage({
        project: "p961",
        kind: "comment_added",
        ticket_id: id,
        body: null,
        by_agent: "claude-aiball-dev",
        decision_kind: "plan",
        summary_until: "accepted",
    } as never);
    getDb().update(schema.messages)
        .set({
            status: "approved",
            meta: JSON.stringify({ decision: { kind: "plan", status: "accepted" } }),
        })
        .where(eq(schema.messages.id, c.id))
        .run();
    // Sanity : the row IS in the merge pool.
    const persisted = getDb().select()
        .from(schema.messages)
        .where(eq(schema.messages.id, c.id))
        .get();
    assert.ok(persisted, `comment row id=${c.id} must exist in _messages`);
    assert.equal(persisted!.kind, "comment_added");
    assert.equal(persisted!.status, "approved");
    const gate = decisionGateByTicket();
    assert.equal(
        gate.get(id),
        false,
        "comment_added(plan,accepted) replayed AFTER ticket_created(plan,pending) → un-gated",
    );
});
