/**
 * #3449 — a project's owner hears every event of the project, but a ticket
 * assigned to another agent is one to read, not one to be woken for: the
 * ping stays unread, it is not in the wake FIFO, and its live event says
 * `wakes: false`. A ticket that names the owner still wakes it.
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
