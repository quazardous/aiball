/**
 * #3388 — the actionable sets hear `ticketChanged` instead of being called by
 * each write. For each kind of write, what a warm cache serves for the tickets
 * it touched equals a fresh computation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3388-flags-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject, computeActionableTicketIds } = await import("./projects.js");
const { upsertSubscription } = await import("./subscriptions.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const m = await import("./messages.js");
const t = await import("./tickets.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "flags" });
upsertSubscription("worker", "flags", "owner");
const boss = testCaller("boss", { kind: "human" });
const post = async (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number }>;
const ticket = async (title: string) => (await post({ kind: "ticket_created", project: "flags", title, body: "b" })).id;

const worker = testCaller("worker");
const say = async (id: number, extra: Record<string, unknown>) =>
    getMethod("message.post")!.run(worker, { kind: "comment_added", ticket_id: id, body: "w", summary_until: "s", commits: null, ...extra }) as Promise<{ id: number }>;

type View = { open: boolean; actionable: boolean; gated: boolean };
const view = (set: ReturnType<typeof computeActionableTicketIds>, id: number): View =>
    ({ open: set.openIds.has(id), actionable: set.actionableIds.has(id), gated: set.gatedByBlockerIds.has(id) });

/**
 * Warm the cache, write, then what is served for `id` must equal a fresh
 * computation — and must have MOVED: a write that changes nothing for the
 * worker would pass with no repair at all.
 */
async function moves(label: string, id: number, write: () => unknown) {
    const before = view(computeActionableTicketIds("worker"), id);
    await write();
    const served = view(computeActionableTicketIds("worker"), id);
    assert.deepEqual(served, view(computeActionableTicketIds("worker", [id]), id), `${label}: served equals fresh`);
    assert.notDeepEqual(served, before, `${label}: the write moved the worker's view of #${id}`);
}

test("each write that moves a ticket in an agent's view moves it in the warm cache too", async () => {
    const a = await ticket("a");
    const b = await ticket("b");
    await moves("the agent speaks last", a, () => say(a, { handback: true }));
    await moves("the human answers", a, () => post({ kind: "comment_added", ticket_id: a, body: "c" }));
    await moves("a dependency", a, () => m.insertTypedRelation({ source_ticket_id: a, target_ticket_id: b, relation_kind: "depends_on", by_agent: "boss" }));
    await moves("the blocker closed", a, () => post({ kind: "ticket_closed", ticket_id: b, body: "" }));
    await moves("the ticket closed", a, () => post({ kind: "ticket_closed", ticket_id: a, body: "" }));
    await moves("the ticket reopened", a, () => post({ kind: "ticket_reopened", ticket_id: a, body: "" }));
    let plan = 0;
    await moves("a pending plan", a, async () => { plan = (await say(a, { decision_kind: "plan" })).id; });
    await moves("the plan accepted", a, () => m.applyMessageDecision(plan, "accepted", "boss"));
    await moves("a snooze", a, () => t.setTicketPostpone(a, new Date(Date.now() + 3_600_000).toISOString()));
    await moves("the snooze lifted", a, () => t.setTicketPostpone(a, null));
});
