/**
 * #3331 — the inbox aggregate is cached for 60 s: every write to a thread must
 * repair or clear it, or a reader sees a stale row for up to a minute. For each
 * kind of write, the aggregate served from a warm cache equals a cold rebuild.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3331-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const { buildInboxAgg, getInboxAgg } = await import("./inbox-agg.js");
const m = await import("./messages.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "writers" });
createProject({ name: "writers-2" });
const boss = testCaller("boss", { kind: "human" });
const post = async (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number }>;
const ticket = async (title: string) => (await post({ kind: "ticket_created", project: "writers", title, body: "b" })).id;
const comment = async (t: number, extra: Record<string, unknown> = {}) => (await post({ kind: "comment_added", ticket_id: t, body: "c", ...extra })).id;

/** Warm the cache, write, then the served entry must equal a cold rebuild. */
async function afterWrite(label: string, t: number, write: () => unknown, project = "writers") {
    getInboxAgg(project);
    await new Promise((r) => setTimeout(r, 5)); // a later created_at than what the warm map saw
    await write();
    assert.deepEqual(getInboxAgg(project).get(t), buildInboxAgg(project).get(t), label);
}

test("every kind of write keeps the cached aggregate equal to a cold rebuild", async () => {
    const t = await ticket("t");
    const other = await ticket("other");
    await comment(t);
    await afterWrite("a comment", t, () => comment(t));
    await afterWrite("a close", t, () => post({ kind: "ticket_closed", ticket_id: t, body: "" }));
    await afterWrite("a reopen", t, () => post({ kind: "ticket_reopened", ticket_id: t, body: "" }));
    const plan = await comment(t, { decision_kind: "plan" });
    await afterWrite("a decision", t, () => m.applyMessageDecision(plan, "accepted", "boss"));
    const res = await comment(t, { decision_kind: "resolution" });
    await afterWrite("a reclassified decision", t, () => m.reclassifyMessageDecision(res, "plan"));
    await afterWrite("a removed decision", t, () => m.removeMessageDecision(res));
    const plain = await comment(t);
    await afterWrite("a promoted decision", t, () => m.promoteMessageToDecision(plain, "plan", undefined, "boss"));
    const stepped = await comment(t);
    await afterWrite("a step tagged", t, () => m.tagMessageAsStep(stepped, "boss"));
    await afterWrite("a step untagged", t, () => m.untagMessageStep(stepped));
    await afterWrite("a status flip", t, () => m.updateMessageStatus(plain, "rejected", "human", null, "comment_added"));
    await afterWrite("an edit", t, () => m.editMessage(plain, { body: "edited" } as never));
    await afterWrite("a deleted comment", t, () => m.deleteComment(plain, "boss"));
    await afterWrite("a relation event", other, () => m.insertRelationEvent({ target_ticket_id: other, source_ticket_id: t, kind: "ticket_referenced", by_agent: "boss" }));
    await afterWrite("a typed relation", t, () => m.insertTypedRelation({ source_ticket_id: t, target_ticket_id: other, relation_kind: "relates_to", by_agent: "boss" }));
    await afterWrite("a moved ticket, in its new project", t, () => m.moveTicket(t, "writers-2", "boss"), "writers-2");
    assert.equal(getInboxAgg("writers").get(t), buildInboxAgg("writers").get(t), "and gone from the old one");
});
