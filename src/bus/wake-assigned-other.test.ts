/**
 * #3449 — a project's owner hears every event of the project, but a ticket
 * assigned to another agent is one to read, not one to be woken for: the
 * ping stays unread, it is not in the wake FIFO, and its live event says
 * `wakes: false`. A ticket that names the owner, or that it follows (filed,
 * wrote on), still wakes it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3449-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { getMethod } = await import("./methods.js");
await import("./register.js");
const { testCaller } = await import("../tests/lib.js");
const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { onPing } = await import("../event-bus.js");

const P = "p-3449";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
upsertConsumer({ consumer_id: "crew", kind: "agent" });
createProject({ name: P });
upsertSubscription("lead", P, "owner");
upsertSubscription("crew", P, "owner");

const boss = testCaller("boss", { kind: "human" });
const run = (m: string, caller: unknown, p: Record<string, unknown>) => getMethod(m)!.run(caller as never, p as never);
const file = (title: string, extra: Record<string, unknown> = {}) =>
    (run("message.post", boss, { project: P, kind: "ticket_created", title, body: "b", ...extra }) as { id: number }).id;
const counts = (who: string) => ({
    unread: (run("ping.count", testCaller(who), { consumer_id: who }) as { unread: number }).unread,
    wake: (run("ping.count", testCaller(who), { consumer_id: who, for: "wake" }) as { unread: number }).unread,
});
const ids = (who: string, forWake: boolean) =>
    (run("unread.list", testCaller(who), { consumer_id: who, ...(forWake ? { for: "wake" } : {}) }) as { messages: { id: number }[] }).messages.map((m) => m.id);

test("a ticket assigned to the crew: the lead reads it, is not woken; the crew is", () => {
    const events: { who: string; wakes?: false }[] = [];
    const offs = ["lead", "crew"].map((who) => onPing(who, (p) => events.push({ who, wakes: p.wakes })));
    const t = file("for the crew", { assignee: "crew" });
    for (const off of offs) off();

    assert.ok(ids("lead", false).includes(t), "unread for the lead: it is informed");
    assert.ok(!ids("lead", true).includes(t), "not in the lead's wake FIFO");
    assert.deepEqual(counts("lead"), { unread: 1, wake: 0 });
    assert.ok(ids("crew", true).includes(t), "the assignee is woken");

    assert.deepEqual(events.find((e) => e.who === "lead"), { who: "lead", wakes: false }, "the live event says it does not wake");
    assert.deepEqual(events.find((e) => e.who === "crew"), { who: "crew", wakes: undefined }, "the assignee's event says nothing: it wakes");
});

test("a ticket assigned to the crew that names the lead wakes the lead", () => {
    const t = file("needs the lead", { assignee: "crew", body: "@lead can you check the contract" });
    assert.ok(ids("lead", true).includes(t));
});

test("a ticket assigned to nobody wakes every owner, as before", () => {
    const t = file("anyone");
    assert.ok(ids("lead", true).includes(t));
    assert.ok(ids("crew", true).includes(t));
});

test("a ticket the lead follows wakes it: a reply on a ticket it wrote on", () => {
    const t = file("the lead joins in", { assignee: "crew" });
    assert.ok(!ids("lead", true).includes(t), "not followed yet: no wake");
    run("message.post", testCaller("lead"), { kind: "comment_added", ticket_id: t, parent_id: t, body: "noted", summary_until: "s", handback: true, commits: null });
    const reply = run("message.post", boss, { kind: "comment_added", ticket_id: t, parent_id: t, body: "thanks" }) as { id: number };
    assert.ok(ids("lead", true).includes(reply.id), "the boss's reply wakes the lead, who wrote on it");
});

test("a specialist's ticket, assigned to the crew, still wakes it on a reply", () => {
    upsertConsumer({ consumer_id: "spec", kind: "agent" });
    run("consumer.update", boss, { consumer_id: "spec", can_claim: false });
    upsertSubscription("spec", P, "owner");
    const t = (run("message.post", testCaller("spec"), { project: P, kind: "ticket_created", title: "filed by spec", body: "b" }) as { id: number }).id;
    run("ticket.assign", boss, { id: t, assignee: "crew" });
    const other = file("not spec's", { assignee: "crew" });
    const reply = run("message.post", boss, { kind: "comment_added", ticket_id: t, parent_id: t, body: "on it" }) as { id: number };
    assert.ok(ids("spec", true).includes(reply.id), "the reply on its own ticket wakes the specialist");
    assert.ok(!ids("spec", true).includes(other), "a ticket it does not follow does not");
});

test("the counters say how many unread pings wake the agent, apart from the unread ones", async () => {
    const { computeCounters } = await import("../agent-counters.js");
    const before = computeCounters("lead");
    file("crew only", { assignee: "crew" });
    const after = computeCounters("lead");
    assert.equal(after.events, before.events + 1, "one more unread ping");
    assert.equal(after.wakes, before.wakes, "but no more that wake: the countdown has nothing to arm on");
    file("anyone's");
    const then = computeCounters("lead");
    assert.equal(then.events, after.events + 1);
    assert.equal(then.wakes, after.wakes + 1, "a ticket that wakes it counts in both");
});
