/**
 * #837 — submitMessage auto-prunes the author's unread on the ticket.
 * An agent who POSTS on a thread has read what was there ; their own
 * unread pings on that ticket are stale by construction. Other consumers'
 * unread is untouched (markTicketSeen is consumer-scoped).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-837-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject } = await import("./db/projects.js");
const { upsertSubscription } = await import("./db/subscriptions.js");
const { insertPing, unreadCount } = await import("./db/pings.js");
const { updateMessageStatus } = await import("./db/messages.js");

getDb();
createProject({ name: "p837" });
upsertConsumer({ consumer_id: "david", kind: "human" });
upsertConsumer({ consumer_id: "agent-a", kind: "agent" });
upsertConsumer({ consumer_id: "agent-b", kind: "agent" });
upsertSubscription("agent-a", "p837", "owner");
upsertSubscription("agent-b", "p837", "owner");

function freshApprovedTicket(): { id: number; ticketMsg: import("./db/connection.js").Message } {
    const t = submitMessage({
        project: "p837",
        kind: "ticket_created",
        title: "fixture",
        body: "test",
        by_agent: "david",
    });
    if (t.status !== "approved") {
        updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    }
    return { id: t.id, ticketMsg: t };
}

test("#837 — author who posts on a ticket auto-prunes their own unread on it", () => {
    const { id: tid, ticketMsg } = freshApprovedTicket();
    // Seed unread pings on the ticket for agent-a (= simulate prior
    // david-posted comments that agent-a never acked).
    insertPing("agent-a", ticketMsg);
    const c1 = submitMessage({
        project: "p837",
        kind: "comment_added",
        ticket_id: tid,
        body: "older comment",
        by_agent: "david",
    });
    insertPing("agent-a", c1);
    const beforeUnread = unreadCount("agent-a", "p837");
    assert.ok(beforeUnread >= 2, `agent-a has ${beforeUnread} unread pre-post`);
    // agent-a POSTS on the ticket → should mark their own pings on this
    // ticket as seen.
    submitMessage({
        project: "p837",
        kind: "comment_added",
        ticket_id: tid,
        body: "agent-a replies — has read prior context",
        by_agent: "agent-a",
    });
    const afterUnread = unreadCount("agent-a", "p837");
    assert.equal(afterUnread, 0, `agent-a's own unread on the ticket should drop to 0 (was ${beforeUnread})`);
});

test("#837 — other consumers' unread on the same ticket are NOT affected", () => {
    const { id: tid, ticketMsg } = freshApprovedTicket();
    // Seed unread for both agents.
    insertPing("agent-a", ticketMsg);
    insertPing("agent-b", ticketMsg);
    const c1 = submitMessage({
        project: "p837",
        kind: "comment_added",
        ticket_id: tid,
        body: "comment from david",
        by_agent: "david",
    });
    insertPing("agent-a", c1);
    insertPing("agent-b", c1);
    const aBefore = unreadCount("agent-a", "p837");
    const bBefore = unreadCount("agent-b", "p837");
    assert.ok(aBefore >= 2);
    assert.ok(bBefore >= 2);
    // agent-a posts — should prune ONLY agent-a's pings on this ticket.
    submitMessage({
        project: "p837",
        kind: "comment_added",
        ticket_id: tid,
        body: "agent-a posts",
        by_agent: "agent-a",
    });
    const aAfter = unreadCount("agent-a", "p837");
    const bAfter = unreadCount("agent-b", "p837");
    assert.equal(aAfter, 0, "agent-a's unread cleared");
    // agent-b gains +1 from the fan-out of agent-a's NEW comment (he's
    // a subscriber). The point is that the auto-prune only touched
    // agent-a's pings — agent-b's prior pings are still there + the
    // new fan-out lands as expected.
    assert.equal(bAfter, bBefore + 1, `agent-b's prior pings untouched, +1 from agent-a's new comment fan-out (was ${bBefore}, now ${bAfter})`);
});
