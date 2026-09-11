/**
 * #2275 — an agent's comment carries a decision or says it is only a comment,
 * and so does a ticket an agent creates.
 * What must hold, over the real HTTP route: an agent's comment with neither
 * `then` nor `comment_only: true` is refused and nothing is posted; the flag or
 * a decision lets it through; a human is exempt; naming a human in `by_agent`
 * does not exempt an agent; a moderator can switch the rule off per project.
 * A ticket an agent creates follows the same rule, with `then: plan` as its only
 * decision.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2275-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { applyModeration } = await import("./moderation.js");
const { setConfigOverride, deleteConfigOverride } = await import("../db/config-overrides.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2275-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2275-a" }).token;
createProject({ name: "p-2275" });
createProject({ name: "p-2275-off" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ticket(project = "p-2275"): number {
    const t = submitMessage({ project, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" });
    if (t.status !== "approved") applyModeration(t as never, "approved", "boss");
    return t.id;
}
const comments = (ticketId: number) =>
    getDb().select().from(schema.messages).where(and(eq(schema.messages.ticketId, ticketId), eq(schema.messages.kind, "comment_added"))).all().length;
async function post(token: string, payload: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() as { error?: string } };
}
function comment(token: string, ticketId: number, extra: Record<string, unknown> = {}, project = "p-2275") {
    return post(token, { project, kind: "comment_added", ticket_id: ticketId, body: "an update", summary_until: "state", ...extra });
}

let seq = 0;
/** Files a ticket with a title nobody else uses, so its row can be counted. */
async function newTicket(token: string, extra: Record<string, unknown> = {}, project = "p-2275") {
    const title = `filed by the test #${++seq}`;
    const r = await post(token, { project, kind: "ticket_created", title, body: "something", ...extra });
    const created = getDb().select().from(schema.tickets).where(eq(schema.tickets.title, title)).all().length;
    return { ...r, created };
}

test("an agent's comment with neither then nor comment_only is refused, and nothing is posted", async () => {
    const t = ticket();
    const r = await comment(AGENT, t);
    assert.equal(r.status, 400);
    assert.match(r.json.error ?? "", /comment_only: true/);
    assert.equal(comments(t), 0);
});

test("comment_only: true lets it through", async () => {
    const t = ticket();
    assert.equal((await comment(AGENT, t, { comment_only: true })).status, 201);
    assert.equal(comments(t), 1);
});

test("a decision lets it through without the flag", async () => {
    const t = ticket();
    assert.equal((await comment(AGENT, t, { decision_kind: "plan" })).status, 201);
});

test("a human is exempt", async () => {
    const t = ticket();
    assert.equal((await comment(HUMAN, t)).status, 201);
});

test("naming a human in by_agent does not exempt an agent", async () => {
    const t = ticket();
    assert.equal((await comment(AGENT, t, { by_agent: "boss" })).status, 400);
    assert.equal(comments(t), 0);
});

test("tickets.require_then = false switches the rule off for that project only", async () => {
    setConfigOverride("p-2275-off", "tickets.require_then", false);
    try {
        const off = ticket("p-2275-off");
        assert.equal((await comment(AGENT, off, {}, "p-2275-off")).status, 201);
        const on = ticket();
        assert.equal((await comment(AGENT, on)).status, 400);
    } finally {
        deleteConfigOverride("p-2275-off", "tickets.require_then");
    }
});

test("an agent's ticket with neither then: plan nor comment_only is refused, and nothing is created", async () => {
    const r = await newTicket(AGENT);
    assert.equal(r.status, 400);
    assert.match(r.json.error ?? "", /then: plan/);
    assert.equal(r.created, 0);
    const named = await newTicket(AGENT, { by_agent: "boss" });
    assert.equal(named.status, 400, "naming a human in by_agent does not exempt an agent");
    assert.equal(named.created, 0);
});

test("an agent's ticket goes through with then: plan, or with comment_only: true", async () => {
    const planned = await newTicket(AGENT, { decision_kind: "plan" });
    assert.equal(planned.status, 201);
    assert.equal(planned.created, 1);
    const note = await newTicket(AGENT, { comment_only: true });
    assert.equal(note.status, 201);
    assert.equal(note.created, 1);
});

test("a human's ticket needs neither, and the switch covers tickets too", async () => {
    assert.equal((await newTicket(HUMAN)).status, 201);
    setConfigOverride("p-2275-off", "tickets.require_then", false);
    try {
        assert.equal((await newTicket(AGENT, {}, "p-2275-off")).status, 201);
        assert.equal((await newTicket(AGENT)).status, 400);
    } finally {
        deleteConfigOverride("p-2275-off", "tickets.require_then");
    }
});
