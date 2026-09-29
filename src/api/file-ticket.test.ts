/**
 * #3037 — a ticket filed in one call, with its tags, assignee, milestone,
 * level and parent. Over the bus:
 * - everything lands, and one creation event announces the ticket, already
 *   whole (tags, assignee, milestone, level on it): what the automation sees;
 * - an unknown tag, a released milestone, a level or an assignment the caller
 *   may not set, a parent that is not a ticket: refused whole, with the
 *   field named and its code — and no ticket is created.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3037-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage, listMessageTags } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { insertTag } = await import("../db/tags.js");
const { milestonesOf } = await import("../db/milestones.js");
const { onLifecycle } = await import("../event-bus.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-3037";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3037-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3037-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
insertTag({ name: "front" });
insertTag({ name: "urgent-ish" });

function milestone(title: string, released = false): number {
    const id = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
    getDb().update(schema.tickets).set({ level: "milestone" }).where(eq(schema.tickets.id, id)).run();
    if (released) submitMessage({ project: P, kind: "ticket_closed", ticket_id: id, parent_id: id, body: "done", by_agent: "boss" });
    return id;
}
const V1 = milestone("v1");
const V0 = milestone("v0", true);
const PARENT = submitMessage({ project: P, kind: "ticket_created", title: "parent", body: "x", by_agent: "boss" }).id;

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function file(token: string, extra: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    return asToken<Record<string, unknown>>(token, "message.post", { project: P, kind: "ticket_created", title: "t", body: "b", ...extra });
}
const ticketCount = () => getDb().select().from(schema.tickets).all().length;

test("a whole ticket in one call, announced once and already whole", async () => {
    const announced: { tags: string[]; assignee: string | null; milestone: number | null; level: string | null }[] = [];
    const ops: string[] = [];
    const off = onLifecycle((e) => {
        const m = e.message;
        if (m.kind !== "ticket_created" || m.project !== P || m.title !== "t") return;
        ops.push(e.op);
        if (e.op !== "created") return;
        const t = getMessage(m.id)!;
        announced.push({
            tags: listMessageTags(m.id).map((x) => x.name).sort(),
            assignee: t.assignee ?? null,
            milestone: milestonesOf([m.id]).get(m.id)?.id ?? null,
            level: t.level ?? null,
        });
    });
    try {
        const r = await file(HUMAN, { tags: ["front", "urgent-ish"], assignee: "worker", milestone: V1, level: "task", parent_id: PARENT });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const id = r.json.id as number;
        const t = getMessage(id)!;
        assert.deepEqual(listMessageTags(id).map((x) => x.name).sort(), ["front", "urgent-ish"]);
        assert.equal(t.assignee, "worker");
        assert.equal(milestonesOf([id]).get(id)?.id, V1);
        assert.deepEqual(announced, [{ tags: ["front", "urgent-ish"], assignee: "worker", milestone: V1, level: "task" }], "one creation event, of the whole ticket");
        assert.deepEqual(ops, ["created"], "no follow-up event (tagged, assigned…)");
    } finally {
        off();
    }
});

test("a human sets a level other than task at creation", async () => {
    const r = await file(HUMAN, { level: "milestone" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(getMessage(r.json.id as number)?.level, "milestone");
});

const refusals: [string, string, Record<string, unknown>, number, string][] = [
    ["an unknown tag", HUMAN, { tags: ["front", "nope"] }, 400, "TAG_UNKNOWN"],
    ["a released milestone", HUMAN, { milestone: V0 }, 400, "MILESTONE_RELEASED"],
    ["a milestone that is not one", HUMAN, { milestone: PARENT }, 400, "MILESTONE_INVALID"],
    ["an agent setting a milestone", WORKER, { milestone: V1 }, 403, "LEVEL_READ_ONLY"],
    ["an agent setting a level", WORKER, { level: "roadmap" }, 403, "MODERATOR_ONLY"],
    ["an agent assigning", WORKER, { assignee: "boss" }, 403, "MODERATOR_ONLY"],
    ["an assignee nobody is", HUMAN, { assignee: "ghost" }, 400, "CONSUMER_NOT_FOUND"],
    ["a parent that is not a ticket", HUMAN, { parent_id: 987654321 }, 404, "TICKET_NOT_FOUND"],
];
for (const [name, token, extra, status, code] of refusals) {
    test(`refused whole, nothing created: ${name}`, async () => {
        const before = ticketCount();
        const r = await file(token, { tags: ["front"], ...extra });
        assert.deepEqual([r.status, r.json.code], [status, code], JSON.stringify(r.json));
        assert.equal(ticketCount(), before, "no ticket, not even a half one");
    });
}
