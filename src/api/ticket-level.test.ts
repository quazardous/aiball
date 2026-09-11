/**
 * #2216/#2241 — a ticket's level: `task` (default), `milestone`, `roadmap`.
 * Every consumer works the same way, only the scope differs: a coder agent works
 * on tasks, a cto agent on milestones and roadmap, a human on everything. The
 * scope decides the actionable pool, the notifications and what an agent may
 * claim; tickets out of scope stay open and readable. The level is set by a human
 * only, and moving a ticket its holder does not work on says so. Spawns the real
 * app on an ephemeral port for the HTTP cases.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2241-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage } = await import("../db.js");
const { updateConsumer } = await import("../db/consumers.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, computeActionableTicketIds } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setTicketClaim } = await import("../db/tickets.js");
const { applyModeration } = await import("./moderation.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const db = getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "coder", kind: "agent" });
upsertConsumer({ consumer_id: "cto", kind: "agent" });
updateConsumer("cto", { agent_type: "cto" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2241-h" }).token;
const CODER = issueToken({ kind: "agent", consumer_id: "coder", label: "2241-c" }).token;
const CTO = issueToken({ kind: "agent", consumer_id: "cto", label: "2241-t" }).token;
createProject({ name: "p-2241" });
upsertSubscription("coder", "p-2241", "owner");
upsertSubscription("cto", "p-2241", "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Approved, as a human-filed ticket or comment is on this board. */
function approved<T extends { id: number; status: string; kind: string }>(m: T): T {
    if (m.status !== "approved") applyModeration(m as never, "approved", "boss");
    return m;
}
const newTicket = (title: string) =>
    approved(submitMessage({ project: "p-2241", kind: "ticket_created", title, body: "x", by_agent: "boss" }));
const comment = (ticketId: number) =>
    approved(submitMessage({ project: "p-2241", kind: "comment_added", ticket_id: ticketId, body: "news", by_agent: "boss" }));
const post = (token: string, path: string, body: unknown) => fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
});
const setLevel = (token: string, id: number, level: string) => post(token, `/messages/${id}/edit`, { level });
const claim = (token: string, id: number) => post(token, `/tickets/${id}/assign`, {});
const pinged = (commentId: number) =>
    db.select({ r: schema.pings.recipient }).from(schema.pings).where(eq(schema.pings.commentId, commentId)).all().map((x) => x.r).sort();
async function ticketAt(title: string, level: "task" | "milestone" | "roadmap") {
    const t = newTicket(title);
    if (level !== "task") assert.equal((await setLevel(HUMAN, t.id, level)).status, 200);
    return t;
}

test("a new ticket is a `task` by default", () => {
    assert.equal(getMessage(newTicket("plain").id)?.level, "task");
});

test("an agent cannot set a level (403); a human can", async () => {
    const t = newTicket("to promote");
    assert.equal((await setLevel(CTO, t.id, "roadmap")).status, 403);
    assert.equal(getMessage(t.id)?.level, "task");
    const res = await setLevel(HUMAN, t.id, "roadmap");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { warning?: string }).warning, undefined, "nobody held it: no warning");
    assert.equal(getMessage(t.id)?.level, "roadmap");
});

test("an unknown level is refused, the retired names included", async () => {
    const t = newTicket("bad level");
    for (const bad of ["cap", "steering", "work"]) assert.equal((await setLevel(HUMAN, t.id, bad)).status, 400, bad);
    assert.equal(getMessage(t.id)?.level, "task");
});

test("the actionable pool follows the scope: coder → task, cto → milestone + roadmap, all stay open", async () => {
    const roadmap = await ticketAt("objective", "roadmap");
    const milestone = await ticketAt("deliverable", "milestone");
    const task = await ticketAt("work item", "task");
    const ids = [roadmap.id, milestone.id, task.id];
    const coder = computeActionableTicketIds("coder", ids).actionableIds;
    assert.deepEqual([coder.has(roadmap.id), coder.has(milestone.id), coder.has(task.id)], [false, false, true]);
    const cto = computeActionableTicketIds("cto", ids).actionableIds;
    assert.deepEqual([cto.has(roadmap.id), cto.has(milestone.id), cto.has(task.id)], [true, true, false]);
    const open = computeActionableTicketIds(undefined, ids).openIds;
    assert.deepEqual(ids.map((id) => open.has(id)), [true, true, true], "out of scope is not closed");
});

test("news reaches only the owners working on that level", async () => {
    const roadmap = await ticketAt("objective with news", "roadmap");
    const milestone = await ticketAt("deliverable with news", "milestone");
    const task = await ticketAt("work item with news", "task");
    assert.deepEqual(pinged(comment(roadmap.id).id), ["cto"]);
    assert.deepEqual(pinged(comment(milestone.id).id), ["cto"]);
    assert.deepEqual(pinged(comment(task.id).id), ["coder"]);
});

test("an agent claims only within its scope (403 outside); a human claims anything", async () => {
    const roadmap = await ticketAt("claim objective", "roadmap");
    const milestone = await ticketAt("claim deliverable", "milestone");
    const task = await ticketAt("claim work", "task");

    const cto403 = await claim(CTO, task.id);
    assert.equal(cto403.status, 403);
    assert.match(((await cto403.json()) as { error: string }).error, /task ticket.*roadmap and milestone/);
    assert.equal((await claim(CODER, roadmap.id)).status, 403);
    assert.equal((await claim(CODER, milestone.id)).status, 403);

    assert.equal((await claim(CTO, milestone.id)).status, 200);
    assert.equal((await claim(CODER, task.id)).status, 200);
    assert.equal((await claim(HUMAN, roadmap.id)).status, 200);
});

test("moving a ticket its holder does not work on says so, without blocking", async () => {
    const t = newTicket("held");
    setTicketClaim(t.id, "coder");
    const res = await setLevel(HUMAN, t.id, "roadmap");
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { warning?: string }).warning ?? "", /held by coder, who does not work on roadmap tickets/);
    assert.equal(getMessage(t.id)?.level, "roadmap");

    const m = await ticketAt("held deliverable", "milestone");
    setTicketClaim(m.id, "cto");
    const within = await setLevel(HUMAN, m.id, "roadmap");
    assert.equal(((await within.json()) as { warning?: string }).warning, undefined, "cto works on roadmap too: no warning");
});
