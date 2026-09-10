/**
 * #2216 — a ticket's level. A `steering` ticket stays readable by anyone but
 * passes over the backlog and the notifications of agents of type `coder`,
 * project owners included; humans and `cto` agents keep it. The level is set by
 * a human only, and promoting a ticket a coder holds says so. Spawns the real
 * app on an ephemeral port for the HTTP cases.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2216-"));
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
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2216-h" }).token;
const CODER = issueToken({ kind: "agent", consumer_id: "coder", label: "2216-c" }).token;
createProject({ name: "p-2216" });
upsertSubscription("coder", "p-2216", "owner");
upsertSubscription("cto", "p-2216", "owner");

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
    approved(submitMessage({ project: "p-2216", kind: "ticket_created", title, body: "x", by_agent: "boss" }));
const comment = (ticketId: number) =>
    approved(submitMessage({ project: "p-2216", kind: "comment_added", ticket_id: ticketId, body: "news", by_agent: "boss" }));
const setLevel = (token: string, id: number, level: string) => fetch(`${BASE}/api/messages/${id}/edit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ level }),
});
const pinged = (commentId: number) =>
    db.select({ r: schema.pings.recipient }).from(schema.pings).where(eq(schema.pings.commentId, commentId)).all().map((x) => x.r).sort();

test("a new ticket is `work` by default", () => {
    assert.equal(getMessage(newTicket("plain").id)?.level, "work");
});

test("an agent cannot set a level (403); a human can", async () => {
    const t = newTicket("to promote");
    assert.equal((await setLevel(CODER, t.id, "steering")).status, 403);
    assert.equal(getMessage(t.id)?.level, "work");
    const res = await setLevel(HUMAN, t.id, "steering");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { warning?: string }).warning, undefined, "nobody held it: no warning");
    assert.equal(getMessage(t.id)?.level, "steering");
});

test("an unknown level is refused", async () => {
    const t = newTicket("bad level");
    assert.equal((await setLevel(HUMAN, t.id, "cap")).status, 400);
    assert.equal(getMessage(t.id)?.level, "work");
});

test("a steering ticket passes over a coder's backlog, not a cto's, and stays open", async () => {
    const steering = newTicket("objective");
    const work = newTicket("task");
    assert.equal((await setLevel(HUMAN, steering.id, "steering")).status, 200);
    const ids = [steering.id, work.id];
    const coder = computeActionableTicketIds("coder", ids).actionableIds;
    assert.equal(coder.has(steering.id), false, "not in the coder's pool");
    assert.equal(coder.has(work.id), true);
    const cto = computeActionableTicketIds("cto", ids).actionableIds;
    assert.equal(cto.has(steering.id), true, "still in the cto's pool");
    assert.equal(computeActionableTicketIds(undefined, ids).openIds.has(steering.id), true, "still open");
});

test("news on a steering ticket reaches the cto owner, not the coder owner", async () => {
    const steering = newTicket("objective with news");
    const work = newTicket("task with news");
    assert.equal((await setLevel(HUMAN, steering.id, "steering")).status, 200);
    assert.deepEqual(pinged(comment(steering.id).id), ["cto"]);
    assert.deepEqual(pinged(comment(work.id).id), ["coder", "cto"]);
});

test("promoting a ticket a coder holds says so, without blocking", async () => {
    const t = newTicket("held");
    setTicketClaim(t.id, "coder");
    const res = await setLevel(HUMAN, t.id, "steering");
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { warning?: string }).warning ?? "", /held by coder/);
    assert.equal(getMessage(t.id)?.level, "steering");
});
