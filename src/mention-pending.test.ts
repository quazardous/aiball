/**
 * #3396 — a mention reaches its target when the message is approved, like the
 * subscribers' pings: a ticket still awaiting moderation woke the agent it
 * mentioned. At once when approved at submit, at the approval otherwise, never
 * when rejected.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3396-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("./tests/bus-call.js");
const { issueToken } = await import("./db/tokens.js");
const { upsertConsumer } = await import("./db.js");
const { getDb } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { createProject } = await import("./db/projects.js");
const { sql } = await import("drizzle-orm");

const P = "p-3396";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "buddy", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3396-h" }).token;
createProject({ name: P });
after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** buddy's pings for one message: a ticket's or a comment's. */
function pinged(id: number): number {
    return getDb().all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM pings WHERE recipient = 'buddy' AND (ticket_id = ${id} OR comment_id = ${id})`)[0].n;
}
const moderate = async (verb: "approve" | "reject", id: number) => {
    const r = await asToken(HUMAN, `message.${verb}`, { id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
};

test("a ticket awaiting moderation does not ping the agent it mentions; its approval does", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "pending", body: "@buddy have a look", by_agent: "worker" });
    assert.equal(t.status, "pending", "precondition: an agent's ticket waits for the moderator");
    assert.equal(pinged(t.id), 0, "nothing before moderation");
    await moderate("approve", t.id);
    assert.equal(pinged(t.id), 1, "the mention lands at the approval");
});

test("a rejected ticket never pings the agent it mentions", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "rejected", body: "@buddy have a look", by_agent: "worker" });
    await moderate("reject", t.id);
    assert.equal(pinged(t.id), 0);
});

test("a ticket approved at submit pings its mention at once", () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "auto", body: "@buddy have a look", by_agent: "boss" });
    assert.equal(t.status, "approved");
    assert.equal(pinged(t.id), 1);
});

test("a comment follows the same rule", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "thread", body: "x", by_agent: "boss" });
    const c = submitMessage({ project: P, kind: "comment_added", ticket_id: t.id, parent_id: t.id, body: "@buddy your turn", by_agent: "worker", handback: true, summary_until: "s", commits: null } as never);
    if (c.status === "pending") {
        assert.equal(pinged(c.id), 0, "nothing before moderation");
        await moderate("approve", c.id);
    }
    assert.equal(pinged(c.id), 1);
});
