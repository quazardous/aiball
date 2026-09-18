/**
 * #2449 david — "si un agent pose un then:continue, ce continue devrait être hot
 * et passer en top du backlog (juste après les events)", for a while (30
 * minutes by default). What must hold, over the real routes:
 * - a fresh step of mine leads my backlog, ahead of an older actionable ticket;
 * - an ordinary comment of mine does not (the anti-loop rule stands);
 * - past the window the step ranks like any other ticket;
 * - the agent decides when it resumes (david): at once by default, or after N
 *   minutes — then the ticket stays out of the wake pool until then, and leads
 *   once it is due;
 * - a resume delay without a step is refused, and a step without a resume
 *   delay is refused too — 0 is how an agent says "at once".
 * Only the RANK moves: the visible `hot` mark keeps its own rule (any agent's
 * recent activity), which this does not touch.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2449-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, invalidateFlagsCache } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2449";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2449-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${WORKER}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function reply(ticketId: number, extra: Record<string, unknown>): Promise<void> {
    const r = await call("POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
type Row = { id: number; backlog_tier: number | null };
async function backlog(): Promise<Row[]> {
    return (await call("GET", `/api/tickets?project=${P}&backlog=1&limit=500`)).json as Row[];
}
function age(ticketId: number, minutes: number): void {
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    getDb().update(schema.tickets).set({ lastActorAt: at }).where(eq(schema.tickets.id, ticketId)).run();
    getDb().update(schema.messages).set({ createdAt: at }).where(eq(schema.messages.ticketId, ticketId)).run();
    invalidateFlagsCache();
}

test("a fresh step of mine leads my backlog, ahead of an older actionable ticket", async () => {
    const older = ticket("an older ticket in my court");
    const stepped = ticket("the ticket I carry on");
    await call("POST", `/api/tickets/${stepped}/assign`, {});
    await reply(stepped, { step: true, step_after_minutes: 0 });

    const rows = await backlog();
    const mine = rows.find((r) => r.id === stepped)!;
    assert.equal(mine.backlog_tier, 0, "the step leads");
    assert.equal(rows.find((r) => r.id === older)?.backlog_tier, 1, "the older ticket keeps its tier");
    assert.ok(rows.findIndex((r) => r.id === stepped) < rows.findIndex((r) => r.id === older), "and ranks before it");
});

test("an ordinary comment of mine does not lead — the anti-loop rule stands", async () => {
    const t = ticket("I only comment here");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { handback: false });

    assert.notEqual((await backlog()).find((r) => r.id === t)?.backlog_tier, 0);
});

test("past the window the step ranks like any other ticket", async () => {
    const t = ticket("a step from an hour ago");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_after_minutes: 0 });
    age(t, 60);

    assert.equal((await backlog()).find((r) => r.id === t)?.backlog_tier, 1);
});

async function backlogWithCooldown(): Promise<{ id: number; backlog_tier: number | null; backlog_cooled_until: string | null }[]> {
    return (await call("GET", `/api/tickets?project=${P}&backlog=1&limit=500&cooldown_sec=3600`)).json as { id: number; backlog_tier: number | null; backlog_cooled_until: string | null }[];
}

test("by default a step is due at once: it leads, and nothing holds it", async () => {
    const t = ticket("carry on right away");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_after_minutes: 0 });

    const row = (await backlogWithCooldown()).find((r) => r.id === t)!;
    assert.equal(row.backlog_tier, 0);
    assert.equal(row.backlog_cooled_until, null, "no rest unless the agent asks for one");
});

test("a step with a resume delay rests until then, and leads once it is due", async () => {
    const t = ticket("waiting on a build");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_after_minutes: 20 });

    const resting = (await backlogWithCooldown()).find((r) => r.id === t)!;
    assert.ok(resting.backlog_cooled_until, "out of the wake pool while the build runs");
    const heldFor = (Date.parse(resting.backlog_cooled_until!) - Date.now()) / 60_000;
    assert.ok(heldFor > 19 && heldFor <= 20, `held for ${heldFor.toFixed(1)} min, expected the 20 declared`);

    // Twenty-five minutes later: due, and at the top.
    age(t, 25);
    const meta = JSON.parse(getDb().select({ m: schema.messages.meta }).from(schema.messages)
        .where(eq(schema.messages.ticketId, t)).all().map((r) => r.m).find((m) => m && m.includes("step_resume_at")) ?? "{}");
    const shifted = { ...meta, step_resume_at: new Date(Date.now() - 5 * 60_000).toISOString() };
    getDb().update(schema.messages).set({ meta: JSON.stringify(shifted) }).where(eq(schema.messages.ticketId, t)).run();
    invalidateFlagsCache();
    const due = (await backlogWithCooldown()).find((r) => r.id === t)!;
    assert.equal(due.backlog_cooled_until, null, "the rest is over");
    assert.equal(due.backlog_tier, 0, "and the step leads");
});

test("a resume delay without a step is refused", async () => {
    const t = ticket("a delay on a plain comment");
    const r = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", handback: false, step_after_minutes: 10,
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String((r.json as { error?: string }).error), /only goes with a step/);
});

test("a step without its resume delay is refused, and the refusal teaches the gesture", async () => {
    const t = ticket("a step that forgets when it resumes");
    await call("POST", `/api/tickets/${t}/assign`, {});
    const r = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true,
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String((r.json as { error?: string }).error), /then: continue needs resume_on — \{ timer: 0 \} if you carry on at once/);
});

// #2765 david — `resume_on: { ticket, timer }`: resume when the awaited ticket
// moves, or when the timer runs out, whichever comes first.
test("#2765 a step waiting on another ticket rests until that one moves, and costs no credit", async () => {
    const awaited = ticket("the ticket this one is queued behind");
    const t = ticket("queued behind it");
    await call("POST", `/api/tickets/${t}/assign`, {});
    const r = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true, step_resume_on_ticket: awaited,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    const credit = (r.json as { wait_credit?: { step?: unknown } }).wait_credit;
    assert.equal(credit?.step, undefined, "waiting on a ticket spends nothing");

    const resting = (await backlogWithCooldown()).find((x) => x.id === t)!;
    assert.ok(resting.backlog_cooled_until, "out of the wake pool while the other ticket is still");
    assert.ok(Date.parse(resting.backlog_cooled_until!) - Date.now() > 24 * 3_600_000, "no timer: the rest lasts until it moves");

    // The awaited ticket moves: a reply on it.
    submitMessage({ project: P, kind: "comment_added", ticket_id: awaited, body: "news", by_agent: "boss" });
    invalidateFlagsCache();
    const due = (await backlogWithCooldown()).find((x) => x.id === t)!;
    assert.equal(due.backlog_cooled_until, null, "the rest ends when the awaited ticket moves");
    assert.equal(due.backlog_tier, 0, "and the step leads");
});

test("#2765 with a timer too, whichever comes first: the timer here", async () => {
    const awaited = ticket("a ticket that will not move");
    const t = ticket("queued, with a fallback");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_resume_on_ticket: awaited, step_after_minutes: 20 });
    const resting = (await backlogWithCooldown()).find((x) => x.id === t)!;
    const heldFor = (Date.parse(resting.backlog_cooled_until!) - Date.now()) / 60_000;
    assert.ok(heldFor > 19 && heldFor <= 20, `held ${heldFor.toFixed(1)} min: the timer, not the still ticket`);
});

test("#2765 resume_on.ticket must be another ticket", async () => {
    const t = ticket("a step that waits on nothing real");
    await call("POST", `/api/tickets/${t}/assign`, {});
    const bogus = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true, step_resume_on_ticket: 999999,
    });
    assert.equal(bogus.status, 400, JSON.stringify(bogus.json));
    assert.match(String((bogus.json as { error?: string }).error), /#999999 is not a ticket/);
    const self = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true, step_resume_on_ticket: t,
    });
    assert.equal(self.status, 400, JSON.stringify(self.json));
    assert.match(String((self.json as { error?: string }).error), /names this very ticket/);
    const noStep = await call("POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", handback: false, step_resume_on_ticket: t,
    });
    assert.equal(noStep.status, 400);
});

// #2769 — grampy: a step posted, then the ticket queued `depends_on` another
// open one. The step still lifted it to the top with the triage ending, twice.
// An open dependency outranks my own step; someone else's move is still news.
test("#2769 a step does not lift a ticket gated by an open dependency", async () => {
    const blocker = ticket("the blocker, still open");
    const t = ticket("queued behind the blocker");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_after_minutes: 0 });
    assert.equal((await backlog()).find((r) => r.id === t)?.backlog_tier, 0, "before the gate, the step leads");

    const rel = await call("POST", `/api/tickets/${t}/relations`, { target_ticket_id: blocker, kind: "depends_on" });
    assert.equal(rel.status, 200, JSON.stringify(rel.json));
    invalidateFlagsCache();
    assert.equal((await backlog()).find((r) => r.id === t)?.backlog_tier, 4, "gated: the blocked tier, not the lead");
});

// #2765 david "est-ce que les outils mcp donnent ces infos à l'agent ?" — they
// did not: only the raw meta of a full read. The list row and the ticket header
// now say what a live step resumes on, from the aggregate the UI reads.
test("#2765 ticket_list and ticket_get say what the live step resumes on, until someone speaks", async () => {
    const other = ticket("the ticket it waits on");
    const t = ticket("a step waiting on the other");
    await call("POST", `/api/tickets/${t}/assign`, {});
    await reply(t, { step: true, step_after_minutes: 30, step_resume_on_ticket: other });

    const row = ((await call("GET", `/api/tickets?project=${P}&limit=500`)).json as Array<{ id: number; step: unknown }>).find((r) => r.id === t)!;
    const step = row.step as { resume_at: string | null; resume_on_ticket: number | null };
    assert.equal(step.resume_on_ticket, other, JSON.stringify(row.step));
    assert.ok(step.resume_at && Date.parse(step.resume_at) > Date.now(), "the timer's end");
    const header = (await call("GET", `/api/tickets/${t}`)).json as { ticket: { step: unknown } };
    assert.deepEqual(header.ticket.step, row.step, "the header says the same");

    assert.equal(((await call("GET", `/api/tickets?project=${P}&limit=500`)).json as Array<{ id: number; step: unknown }>).find((r) => r.id === other)?.step, null, "no step, no field value");
    await reply(t, { handback: false });
    assert.equal(((await call("GET", `/api/tickets/${t}`)).json as { ticket: { step: unknown } }).ticket.step, null, "a later word ends it");
});
