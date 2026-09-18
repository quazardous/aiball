/**
 * #2757 — the wake focus expands through the real relations, when it is
 * applied: a sub-ticket filed after the focus was set is in `123+` from then on,
 * a grandchild only in `123++`, and a linked ticket only in `123~`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2757-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("./projects.js");
const { upsertConsumer } = await import("./consumers.js");
const { upsertSubscription } = await import("./subscriptions.js");
const { insertTypedRelation } = await import("./messages.js");
const { setProjectWakeFocus } = await import("./settings.js");
const { wakeFocusHidesTicket } = await import("./backlog-rules.js");

const P = "p2757";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
createProject({ name: P });
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
upsertSubscription("lead", P, "owner");
const ticket = (title: string): number => submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
const childOf = (child: number, parent: number): void => {
    insertTypedRelation({ source_ticket_id: child, target_ticket_id: parent, relation_kind: "child_of", by_agent: "boss" });
};
const focus = (tickets: string): void => setProjectWakeFocus(P, { tickets, until: null });
const wakes = (id: number): boolean => !wakeFocusHidesTicket("lead", id);

test("the focus follows the relations as they are when it applies", () => {
    const parent = ticket("parent");
    const other = ticket("unrelated");
    const linked = ticket("linked");
    insertTypedRelation({ source_ticket_id: linked, target_ticket_id: parent, relation_kind: "relates_to", by_agent: "boss" });

    focus(`${parent}+`);
    const child = ticket("child, filed after the focus");
    childOf(child, parent);
    const grandchild = ticket("grandchild");
    childOf(grandchild, child);

    assert.equal(wakes(parent), true);
    assert.equal(wakes(child), true, "a sub-ticket filed later is in 123+");
    assert.equal(wakes(grandchild), false, "123+ stops at the direct children");
    assert.equal(wakes(other), false);
    assert.equal(wakes(linked), false, "a linked ticket is not a child");

    focus(`${parent}++`);
    assert.equal(wakes(grandchild), true, "123++ reaches every descendant");

    focus(`${parent}~`);
    assert.equal(wakes(linked), true, "123~ reaches what is linked to it");
    assert.equal(wakes(child), true, "a child is linked too");
    assert.equal(wakes(grandchild), false, "123~ is one step");

    focus(`+${grandchild}`);
    assert.equal(wakes(child), true, "+123 reaches the direct parent");
    assert.equal(wakes(parent), false);
    focus(`++${grandchild}`);
    assert.equal(wakes(parent), true, "++123 reaches every ancestor");
});
