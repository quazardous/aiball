/**
 * #569 (david `j8t4qa` greenlight A+C) — guard `assertDecisionOnApprovedTicket` :
 *
 *   ticket_reply (= comment_added) avec `then: "resolved"` ou `then: "plan"`
 *   (= decision_kind:"resolution"/"plan") sur un ticket parent encore en
 *   status `pending` (modération non confirmée) doit throw avec code
 *   `PARENT_PENDING_MODERATION`, mappé HTTP 409 côté API.
 *
 * Setup : throwaway DB pointé via AIBALL_HOME avant les imports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-569-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage, validateNewMessage } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject } = await import("./db/projects.js");
const { updateMessageStatus } = await import("./db/messages.js");

getDb();
createProject({ name: "p569" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent" });
upsertConsumer({ consumer_id: "human-david", kind: "human" });

/** Mock the auto-approve so we land in `pending` (the typical agent
 *  flow when moderation rules don't whitelist the author). We force the
 *  ticket to pending by inserting an agent-authored ticket then leaving
 *  its status unchanged — `submitMessage` evaluates moderation rules but
 *  with no rule matching, default is `pending`. */
function freshPendingTicket(): number {
    const t = submitMessage({
        project: "p569",
        kind: "ticket_created",
        title: "agent-authored",
        body: "still pending",
        by_agent: "agent-x",
    });
    // Without an explicit rule, agent-authored tickets land pending.
    assert.equal(t.status, "pending", "fixture precondition : ticket is pending");
    return t.id;
}

test("#569 — ticket_reply then:resolved on pending → PARENT_PENDING_MODERATION", () => {
    const tid = freshPendingTicket();
    const v = validateNewMessage({
        project: "p569",
        kind: "comment_added",
        ticket_id: tid,
        body: "done",
        decision_kind: "resolution",
        summary_until: "shipped",
        by_agent: "agent-x",
    });
    assert.ok(!("error" in v), `validate should accept the shape : ${JSON.stringify(v)}`);
    let caught: unknown;
    try {
        submitMessage(v as Parameters<typeof submitMessage>[0]);
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof Error);
    const err = caught as Error & { code?: string };
    assert.equal(err.code, "PARENT_PENDING_MODERATION");
    assert.match(err.message, /cannot propose resolution/);
    assert.match(err.message, /status "pending"/);
});

test("#569 — ticket_reply then:plan on pending → PARENT_PENDING_MODERATION", () => {
    const tid = freshPendingTicket();
    let caught: unknown;
    try {
        submitMessage({
            project: "p569",
            kind: "comment_added",
            ticket_id: tid,
            body: "here's my approach",
            decision_kind: "plan",
            summary_until: "plan posed",
            by_agent: "agent-x",
            parent_id: null,
            scope: undefined,
        });
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { code?: string }).code, "PARENT_PENDING_MODERATION");
});

test("#569 — plain comment_added (no `then`) on pending → OK (no guard)", () => {
    const tid = freshPendingTicket();
    // No decision_kind → guard doesn't fire.
    const msg = submitMessage({
        project: "p569",
        kind: "comment_added",
        ticket_id: tid,
        body: "just an update without proposing anything",
        summary_until: "update posted, awaiting moderation",
        by_agent: "agent-x",
        parent_id: null,
        scope: undefined,
    });
    assert.ok(msg.id > 0);
    assert.equal(msg.kind, "comment_added");
});

test("#569 — then:resolved on APPROVED ticket → OK", () => {
    const tid = freshPendingTicket();
    // Approve the parent ticket manually (mimics a moderator action).
    // Pass `kind: "ticket_created"` to disambiguate (#569 collision fix).
    updateMessageStatus(tid, "approved", "human", null, "ticket_created");
    const msg = submitMessage({
        project: "p569",
        kind: "comment_added",
        ticket_id: tid,
        body: "done",
        decision_kind: "resolution",
        summary_until: "shipped abc1234",
        by_agent: "agent-x",
        parent_id: null,
        scope: undefined,
    });
    assert.ok(msg.id > 0);
    assert.equal(msg.kind, "comment_added");
});

test("#569 — human author bypass : then:resolved on pending OK for moderator", () => {
    const tid = freshPendingTicket();
    // Human bypass — chaining ticket+resolution+approve en rafale est légitime.
    const msg = submitMessage({
        project: "p569",
        kind: "comment_added",
        ticket_id: tid,
        body: "chained",
        decision_kind: "resolution",
        summary_until: "human-driven chain",
        by_agent: "human-david",
        parent_id: null,
        scope: undefined,
    });
    assert.ok(msg.id > 0);
});
