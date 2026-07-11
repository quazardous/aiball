// #1323 — the auto-prune at POST must be bounded by the author's own last
// post, so a human comment that landed AFTER it (mid-turn) stays unseen and
// resurfaces, instead of being silently marked read by the agent's reply.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1323-"));

const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { markTicketSeen } = await import("./pings.js");
const { lastAuthoredMessageId } = await import("./messages.js");

const db = getDb();
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const PROJECT = "p1323";
const AGENT = "claude-aiball-dev";
const HUMAN = "david";
const TICKET = 100;

createProject({ name: PROJECT });

db.insert(schema.tickets).values({
    id: TICKET,
    project: PROJECT,
    displaySeq: 1,
    title: "T",
    status: "approved",
    byAgent: HUMAN,
    createdAt: "2026-07-11T10:00:00.000Z",
}).run();

// Comment timeline on the ticket (ids in the _messages range):
//   1_000_005  human  — an OLD comment the agent already dealt with
//   1_000_010  AGENT  — the agent's own last post (the read watermark)
//   1_000_020  human  — a NEW comment that landed AFTER the agent's post
function comment(id: number, by: string, at: string) {
    db.insert(schema.messages).values({
        id,
        ticketId: TICKET,
        kind: "comment_added",
        status: "approved",
        body: `c${id}`,
        byAgent: by,
        displaySeq: id,
        createdAt: at,
        decidedAt: at,
        decidedBy: "auto",
    }).run();
}
comment(1_000_005, HUMAN, "2026-07-11T10:05:00.000Z");
comment(1_000_010, AGENT, "2026-07-11T10:10:00.000Z");
comment(1_000_020, HUMAN, "2026-07-11T10:20:00.000Z");

// The agent has an unseen ping on both human comments.
// A comment-level ping (the pings CHECK constraint forbids setting both
// ticket_id and comment_id — a comment ping carries comment_id only).
function ping(commentId: number) {
    db.insert(schema.pings).values({
        recipient: AGENT,
        commentId,
        createdAt: "2026-07-11T10:30:00.000Z",
    }).run();
}
ping(1_000_005);
ping(1_000_020);

function seenAt(commentId: number): string | null {
    return (
        db.select({ seenAt: schema.pings.seenAt })
            .from(schema.pings)
            .where(and(eq(schema.pings.recipient, AGENT), eq(schema.pings.commentId, commentId)))
            .get()?.seenAt ?? null
    );
}

test("lastAuthoredMessageId returns the author's last prior post, excluding the new one", () => {
    // The agent is now posting comment 1_000_030.
    assert.equal(lastAuthoredMessageId(AGENT, TICKET, 1_000_030), 1_000_010);
    // Strictly-before: querying at the author's own post id returns nothing older.
    assert.equal(lastAuthoredMessageId(AGENT, TICKET, 1_000_010), null);
    // A human with no post here → null.
    assert.equal(lastAuthoredMessageId("nobody", TICKET, 1_000_030), null);
});

test("bounded prune keeps the newer human comment unseen, prunes the older one", () => {
    const upTo = lastAuthoredMessageId(AGENT, TICKET, 1_000_030);
    assert.equal(upTo, 1_000_010);
    markTicketSeen(AGENT, TICKET, { upTo: upTo! });

    // Old comment (<= watermark): pruned — the #837 replay stays fixed.
    assert.notEqual(seenAt(1_000_005), null, "old comment ping should be marked seen");
    // New comment (> watermark): survives — this is the #1323 fix.
    assert.equal(seenAt(1_000_020), null, "new human comment must stay unseen and resurface");
});
