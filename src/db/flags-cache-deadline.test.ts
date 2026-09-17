// #2682 — the actionable cache lives until the next clock deadline, capped at a
// minute. Each test below reads through a WARM cache, then changes one input,
// and expects the next read to see it at once: without the deadline or the
// invalidation under test, the stale answer would be served for up to a minute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2682-deadline-"));
process.env.AIBALL_SOCK = "";
// A one-second claim window, so a claim can lapse inside a test.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "aiball-2682-xdg-"));
mkdirSync(join(process.env.XDG_CONFIG_HOME, "aiball"), { recursive: true });
writeFileSync(join(process.env.XDG_CONFIG_HOME, "aiball", "config.yaml"), "assign_window_sec: 1\n");

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { computeActionableTicketIds } = await import("./projects.js");
const { resetFlagsCacheForTests } = await import("./flags-cache.js");
const { setTicketClaim, setTicketPostpone } = await import("./tickets.js");
const { upsertSubscription } = await import("./subscriptions.js");
const { updateConsumer, upsertConsumer } = await import("./consumers.js");
const { insertTag, addMessageTag, removeMessageTag } = await import("./tags.js");
const { insertAutomationRule, deleteAutomationRule } = await import("./automation.js");

const P = "p2682";
const OTHER = "other2682";
const db = getDb();
let nextId = 1;
function seed(project = P): number {
    const id = nextId++;
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title: `T${id}`, status: "approved", createdAt: nowIso(),
    }).run();
    return id;
}
const actionable = (c: string) => computeActionableTicketIds(c).actionableIds;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a snooze comes due with no write: the next read sees the ticket back", async () => {
    upsertConsumer({ consumer_id: "snz", kind: "agent" });
    upsertSubscription("snz", P, "owner");
    const id = seed();
    resetFlagsCacheForTests();
    assert.ok(actionable("snz").has(id), "baseline, and the cache is now warm");
    setTicketPostpone(id, new Date(Date.now() + 600).toISOString());
    assert.ok(!actionable("snz").has(id), "snoozed");
    await sleep(750);
    assert.ok(actionable("snz").has(id), "back once the snooze is due, with no write in between");
});

test("another agent's claim lapses with no write: the ticket comes back to my pool", async () => {
    upsertConsumer({ consumer_id: "clm", kind: "agent" });
    upsertSubscription("clm", P, "owner");
    const id = seed();
    resetFlagsCacheForTests();
    assert.ok(actionable("clm").has(id), "baseline, warm");
    setTicketClaim(id, OTHER);
    assert.ok(!actionable("clm").has(id), "held by the other agent");
    await sleep(1_150);
    assert.ok(actionable("clm").has(id), "free again once the 1 s claim window lapsed");
});

test("becoming owner of a project puts its tickets in the pool at once", () => {
    upsertConsumer({ consumer_id: "own", kind: "agent" });
    const id = seed("p2682-own");
    resetFlagsCacheForTests();
    assert.ok(!actionable("own").has(id), "not the agent's project yet, warm");
    upsertSubscription("own", "p2682-own", "owner");
    assert.ok(actionable("own").has(id), "owner now");
});

test("a follower promoted to owner gets the project's tickets at once", () => {
    upsertConsumer({ consumer_id: "prom", kind: "agent" });
    upsertSubscription("prom", "p2682-prom", "follower");
    const id = seed("p2682-prom");
    resetFlagsCacheForTests();
    assert.ok(!actionable("prom").has(id), "a follower's pool holds none of it, warm");
    upsertSubscription("prom", "p2682-prom", "owner");
    assert.ok(actionable("prom").has(id), "owner now");
});

test("a work-filter rule and a tag write both reach the pool at once", () => {
    upsertConsumer({ consumer_id: "wf", kind: "agent" });
    upsertSubscription("wf", P, "owner");
    const id = seed();
    const tag = insertTag({ name: "win2682" });
    addMessageTag(id, tag.id);
    resetFlagsCacheForTests();
    assert.ok(actionable("wf").has(id), "baseline, warm");
    const rule = insertAutomationRule({
        triggers: ["actionable_eval"],
        scope_consumer: "wf",
        match_tags: ["win2682"],
        action: { kind: "pickup", mode: "except" },
    });
    assert.ok(!actionable("wf").has(id), "the new rule skips win-tagged tickets");
    removeMessageTag(id, tag.id);
    assert.ok(actionable("wf").has(id), "untagged: back in the pool");
    deleteAutomationRule(rule.id);
});

test("an agent turned cto drops task-level tickets at once", () => {
    upsertConsumer({ consumer_id: "cto2682", kind: "agent" });
    upsertSubscription("cto2682", P, "owner");
    const id = seed();
    resetFlagsCacheForTests();
    assert.ok(actionable("cto2682").has(id), "a coder works tasks, warm");
    updateConsumer("cto2682", { agent_type: "cto" });
    assert.ok(!actionable("cto2682").has(id), "a cto does not");
});

test("a consumer turned human sees the whole board at once", () => {
    upsertConsumer({ consumer_id: "hum2682", kind: "agent" });
    const id = seed("p2682-hum");
    resetFlagsCacheForTests();
    assert.ok(!actionable("hum2682").has(id), "an agent only sees its own projects, warm");
    updateConsumer("hum2682", { kind: "human" });
    assert.ok(actionable("hum2682").has(id), "a human moderates the whole board");
});
