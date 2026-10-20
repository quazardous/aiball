/**
 * #4127 — a ticket awaiting moderation wakes no one: its events stay unread
 * (#643), are neither a wake nor an FYI line, and wake the owners once the
 * human approves it. A human's comment on it still wakes: a moderator's
 * question before approving must reach someone.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4127-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { getMethod } = await import("./methods.js");
await import("./register.js");
const { testCaller } = await import("../tests/lib.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { onPing } = await import("../event-bus.js");

const P = "p-4127";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
upsertConsumer({ consumer_id: "visitor", kind: "agent" });
createProject({ name: P });
upsertSubscription("boss", P, "owner");
upsertSubscription("lead", P, "owner");

const boss = testCaller("boss", { kind: "human" });
const visitor = testCaller("visitor");
const run = (m: string, caller: unknown, p: Record<string, unknown>) => getMethod(m)!.run(caller as never, p as never);
const ids = (who: string, target?: "wake" | "fyi") =>
    (run("unread.list", testCaller(who), { consumer_id: who, ...(target ? { for: target } : {}) }) as { messages: { id: number }[] }).messages.map((m) => m.id);
const comment = (caller: unknown, t: number, body: string) =>
    (run("message.post", caller, { kind: "comment_added", ticket_id: t, parent_id: t, body, summary_until: "s", handback: true, commits: null }) as { id: number }).id;

test("another agent's ticket, pending: read, not a wake, not an FYI; approved, it wakes", () => {
    const events: { wakes?: false }[] = [];
    const off = onPing("lead", (p) => events.push({ wakes: p.wakes }));
    const t = (run("message.post", visitor, { project: P, kind: "ticket_created", title: "from outside", body: "b" }) as { id: number; status: string });
    assert.equal(t.status, "pending", "an outsider's ticket awaits moderation");
    const c = comment(visitor, t.id, "more context");
    off();

    assert.ok(ids("lead").includes(c), "unread: the lead may read it (#643)");
    assert.deepEqual(ids("lead", "wake").filter((id) => id === t.id || id === c), [], "nothing on it wakes the lead");
    assert.deepEqual(ids("lead", "fyi").filter((id) => id === t.id || id === c), [], "nor rides along a wake, which would mark it read");
    assert.ok(events.length > 0 && events.every((e) => e.wakes === false), "the live events say they do not wake");

    run("message.approve", boss, { id: t.id });
    const woken = ids("lead", "wake");
    assert.ok(woken.includes(c), "approved: the comment waiting on it wakes the lead");
    assert.ok(woken.includes(t.id), "and the ticket itself");
});

test("a human's comment on a pending ticket wakes: the moderator's question reaches someone", () => {
    const t = (run("message.post", visitor, { project: P, kind: "ticket_created", title: "unclear", body: "b" }) as { id: number }).id;
    const q = (run("message.post", boss, { kind: "comment_added", ticket_id: t, parent_id: t, body: "@visitor what do you mean?" }) as { id: number }).id;
    assert.ok(ids("lead", "wake").includes(q) || ids("visitor", "wake").includes(q), "the boss's question wakes");
    assert.ok(ids("visitor", "wake").includes(q), "the author hears the moderator's question");
});

test("a pending ticket's assignee (a key may file one) is pinged at its approval, not while it waits", async () => {
    const { fileTicket } = await import("../file-ticket.js");
    upsertConsumer({ consumer_id: "crew", kind: "agent" });
    upsertSubscription("crew", P, "follower");
    const t = fileTicket({ project: P, kind: "ticket_created", title: "for the crew", body: "b", by_agent: "visitor" } as never,
        { tagIds: [], assignee: "crew", milestone: null, level: null } as never, "visitor");
    assert.equal(t.status, "pending");
    assert.ok(!ids("crew").includes(t.id), "not pinged while pending");
    run("message.approve", boss, { id: t.id });
    assert.ok(ids("crew", "wake").includes(t.id), "pinged, and woken, once approved");
});
