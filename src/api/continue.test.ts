/**
 * #2308 — `then: continue`: a step on a ticket the author holds.
 * What must hold, over the real HTTP route: an agent that does not hold the
 * ticket is refused and nothing is posted, whether nobody holds it or another
 * agent does; the holder's step lands as a step, needs no comment_only, and
 * leaves the ticket's last actor where it was; a step cannot carry a decision.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2308-api-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { applyModeration } = await import("./moderation.js");
const { setTicketClaim } = await import("../db/tickets.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2308-a" }).token;
createProject({ name: "p-2308" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ticket(): number {
    const t = submitMessage({ project: "p-2308", kind: "ticket_created", title: "t", body: "x", by_agent: "boss" });
    if (t.status !== "approved") applyModeration(t as never, "approved", "boss");
    return t.id;
}
const commentsOn = (ticketId: number) =>
    getDb().select().from(schema.messages).where(and(eq(schema.messages.ticketId, ticketId), eq(schema.messages.kind, "comment_added"))).all();
const lastActor = (ticketId: number) =>
    getDb().select({ a: schema.tickets.lastActor }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()?.a ?? null;
async function post(payload: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() as { error?: string } };
}
const step = (ticketId: number, extra: Record<string, unknown> = {}) =>
    post({ project: "p-2308", kind: "comment_added", ticket_id: ticketId, body: "step 1 done", summary_until: "state", step: true, ...extra });

test("an agent that holds nothing cannot post a step, and nothing is posted", async () => {
    const t = ticket();
    const r = await step(t);
    assert.equal(r.status, 409);
    assert.match(r.json.error ?? "", /claim it first/);
    assert.equal(commentsOn(t).length, 0);
});

test("a ticket another agent holds refuses the step and names the holder", async () => {
    const t = ticket();
    setTicketClaim(t, "other");
    const r = await step(t);
    assert.equal(r.status, 409);
    assert.match(r.json.error ?? "", /held by other/);
    assert.equal(commentsOn(t).length, 0);
});

test("the holder's step lands as a step, needs no comment_only, and leaves the last actor where it was", async () => {
    const t = ticket();
    setTicketClaim(t, "worker");
    assert.equal(lastActor(t), "boss");
    const r = await step(t);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const [c] = commentsOn(t);
    assert.equal(JSON.parse(c.meta ?? "{}").step, true);
    assert.equal(lastActor(t), "boss", "a step hands the ticket to nobody");
    const plain = await post({ project: "p-2308", kind: "comment_added", ticket_id: t, body: "a question", summary_until: "state", comment_only: true });
    assert.equal(plain.status, 201, JSON.stringify(plain.json));
    assert.equal(lastActor(t), "worker", "a comment still does");
});

test("a step cannot also carry a decision", async () => {
    const t = ticket();
    setTicketClaim(t, "worker");
    const r = await step(t, { decision_kind: "plan" });
    assert.equal(r.status, 400);
    assert.match(r.json.error ?? "", /exclusive/);
    assert.equal(commentsOn(t).length, 0);
});
