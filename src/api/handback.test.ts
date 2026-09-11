/**
 * #2331 — every agent message says whether it hands the ticket back.
 * What must hold, over the real HTTP route:
 * - a comment with no `then` carries `handback`; without it the comment is
 *   refused and nothing is posted, and `comment_only` is refused by name;
 * - a `then` implies the handback, and a contradicting one is refused;
 * - `handback: false` keeps the hand, so only the holder may post it, and the
 *   ticket stays in its author's pool; `handback: true` hands it back;
 * - a new ticket's handback is deduced: the project's lead keeps it and is
 *   reminded to attach a plan; another project's agent hands it back and the
 *   ticket leaves its pool; a human files freely, and nobody sends a handback;
 * - humans are exempt from the requirement, `by_agent` cannot borrow that, and a
 *   moderator can switch the requirement off per project.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2331-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, lastActorExclusions } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setTicketClaim } = await import("../db/tickets.js");
const { applyModeration } = await import("./moderation.js");
const { setConfigOverride, deleteConfigOverride } = await import("../db/config-overrides.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "outsider", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2331-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2331-a" }).token;
const OUTSIDER = issueToken({ kind: "agent", consumer_id: "outsider", label: "2331-o" }).token;
createProject({ name: "p-2331" });
createProject({ name: "p-2331-off" });
upsertSubscription("worker", "p-2331", "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Reply = { status: number; json: { id?: number; error?: string; warnings?: string[] } };

function ticket(project = "p-2331"): number {
    const t = submitMessage({ project, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" });
    if (t.status !== "approved") applyModeration(t as never, "approved", "boss");
    return t.id;
}
const comments = (ticketId: number) =>
    getDb().select().from(schema.messages).where(and(eq(schema.messages.ticketId, ticketId), eq(schema.messages.kind, "comment_added"))).all().length;
const ticketHandback = (ticketId: number) => {
    const meta = getDb().select({ m: schema.tickets.meta }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()?.m;
    return meta ? (JSON.parse(meta) as { handback?: boolean }).handback : undefined;
};
const waiting = (consumer: string, ticketId: number) => lastActorExclusions(consumer, [ticketId]).has(ticketId);
async function post(token: string, payload: Record<string, unknown>): Promise<Reply> {
    const res = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() as Reply["json"] };
}
function comment(token: string, ticketId: number, extra: Record<string, unknown> = {}, project = "p-2331") {
    return post(token, { project, kind: "comment_added", ticket_id: ticketId, body: "an update", summary_until: "state", ...extra });
}
function newTicket(token: string, extra: Record<string, unknown> = {}, project = "p-2331") {
    return post(token, { project, kind: "ticket_created", title: "filed by the test", body: "something", ...extra });
}

test("a comment with neither then nor handback is refused, and nothing is posted", async () => {
    const t = ticket();
    const r = await comment(AGENT, t);
    assert.equal(r.status, 400);
    assert.match(r.json.error ?? "", /handback: true/);
    assert.match(r.json.error ?? "", /then: continue/, "the refusal names the gestures too");
    assert.equal(comments(t), 0);
});

test("comment_only is refused by name", async () => {
    const t = ticket();
    const r = await comment(AGENT, t, { comment_only: true });
    assert.equal(r.status, 400);
    assert.match(r.json.error ?? "", /comment_only no longer exists/);
    assert.equal(comments(t), 0);
});

test("handback: true lets it through and hands the ticket back", async () => {
    const t = ticket();
    assert.equal((await comment(AGENT, t, { handback: true })).status, 201);
    assert.equal(comments(t), 1);
    assert.equal(waiting("worker", t), true);
});

test("handback: false is for the holder, and keeps the ticket in its author's pool", async () => {
    const t = ticket();
    const refused = await comment(AGENT, t, { handback: false });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error ?? "", /handback: false is for the agent holding the ticket: claim it first/);
    assert.equal(comments(t), 0);
    setTicketClaim(t, "worker");
    assert.equal((await comment(AGENT, t, { handback: false })).status, 201);
    assert.equal(waiting("worker", t), false);
});

test("a then implies the handback, and a contradicting one is refused", async () => {
    const t = ticket();
    assert.equal((await comment(AGENT, t, { decision_kind: "plan" })).status, 201, "a decision needs no handback");
    assert.equal((await comment(AGENT, t, { decision_kind: "plan", handback: true })).status, 201, "a matching one is fine");
    const planKeeps = await comment(AGENT, t, { decision_kind: "plan", handback: false });
    assert.equal(planKeeps.status, 400);
    assert.match(planKeeps.json.error ?? "", /contradicts then: plan/);
    setTicketClaim(t, "worker");
    const stepHandsBack = await comment(AGENT, t, { step: true, handback: true });
    assert.equal(stepHandsBack.status, 400);
    assert.match(stepHandsBack.json.error ?? "", /contradicts then: continue/);
    assert.equal(comments(t), 2);
});

test("a human is exempt, and naming a human in by_agent does not exempt an agent", async () => {
    const t = ticket();
    assert.equal((await comment(HUMAN, t)).status, 201);
    assert.equal((await comment(AGENT, t, { by_agent: "boss" })).status, 400);
    assert.equal(comments(t), 1);
});

test("tickets.require_then = false switches the requirement off for that project only, not the contradiction", async () => {
    setConfigOverride("p-2331-off", "tickets.require_then", false);
    try {
        const off = ticket("p-2331-off");
        assert.equal((await comment(AGENT, off, {}, "p-2331-off")).status, 201);
        assert.equal((await comment(AGENT, off, { decision_kind: "plan", handback: false }, "p-2331-off")).status, 400);
        assert.equal((await comment(AGENT, ticket())).status, 400);
    } finally {
        deleteConfigOverride("p-2331-off", "tickets.require_then");
    }
});

test("a ticket filed by the project's lead keeps it, with a reminder to attach a plan", async () => {
    const bare = await newTicket(AGENT);
    assert.equal(bare.status, 201, JSON.stringify(bare.json));
    assert.match((bare.json.warnings ?? []).join(" "), /then: plan/);
    assert.equal(ticketHandback(bare.json.id!), false);
    assert.equal(waiting("worker", bare.json.id!), false, "the lead's own ticket stays in its pool");
    const planned = await newTicket(AGENT, { decision_kind: "plan" });
    assert.equal(planned.status, 201);
    assert.equal(planned.json.warnings, undefined, "no reminder when the plan is there");
});

test("a ticket filed from outside the project hands it back and leaves its creator's pool", async () => {
    const r = await newTicket(OUTSIDER);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.warnings, undefined);
    assert.equal(ticketHandback(r.json.id!), true);
    assert.equal(waiting("outsider", r.json.id!), true);
});

test("a human files freely, and nobody sends a handback at creation", async () => {
    const human = await newTicket(HUMAN);
    assert.equal(human.status, 201);
    assert.equal(human.json.warnings, undefined);
    const sent = await newTicket(AGENT, { handback: false });
    assert.equal(sent.status, 400);
    assert.match(sent.json.error ?? "", /deduced/);
});
