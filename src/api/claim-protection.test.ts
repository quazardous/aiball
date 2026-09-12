/**
 * #2379 david `prrg57` — "claim est une version faible de assign… tant qu'un
 * agent est actif sur un ticket son claim est protégé pendant X minutes, un
 * autre agent ne peut pas claim un ticket protégé, le assign supplante le
 * claim". What must hold, over the real routes:
 * - a free ticket is claimed as before, and re-claiming one's own is a no-op;
 * - another agent's claim on a PROTECTED ticket is refused, naming the holder;
 * - working on a ticket renews its protection;
 * - past the protection the ticket can be taken over, and the thread says so —
 *   the former holder is told rather than silently dispossessed;
 * - an assignment supersedes a claim: the assignee's ticket is refused to
 *   everyone else, protection or not;
 * - a human is not restricted: moderating is the job.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2379-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2379";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "first", kind: "agent" });
upsertConsumer({ consumer_id: "second", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2379-h" }).token;
const FIRST = issueToken({ kind: "agent", consumer_id: "first", label: "2379-1" }).token;
const SECOND = issueToken({ kind: "agent", consumer_id: "second", label: "2379-2" }).token;
createProject({ name: P });
upsertSubscription("first", P, "owner");
upsertSubscription("second", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
const claim = (token: string, id: number) => call(token, "POST", `/api/tickets/${id}/assign`, {});
function claimantOf(id: number): string | null {
    return getDb().select({ c: schema.tickets.claimant }).from(schema.tickets).where(eq(schema.tickets.id, id)).get()?.c ?? null;
}
/** Move the claim (and the holder's messages) back in time, past the protection. */
function agePast(id: number, minutes: number): void {
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    getDb().update(schema.tickets).set({ claimedAt: at }).where(eq(schema.tickets.id, id)).run();
    getDb().update(schema.messages).set({ createdAt: at }).where(eq(schema.messages.ticketId, id)).run();
}
function takeOverEvents(id: number): string[] {
    return getDb().select({ kind: schema.messages.kind, body: schema.messages.body })
        .from(schema.messages).where(eq(schema.messages.ticketId, id)).all()
        .filter((m) => m.kind === "claim_taken_over")
        .map((m) => m.body ?? "");
}

test("a free ticket is claimed, and re-claiming one's own changes nothing", async () => {
    const t = ticket("free for the taking");

    assert.equal((await claim(FIRST, t)).status, 200);
    assert.equal((await claim(FIRST, t)).status, 200, "its own claim renews, never refuses");
    assert.equal(claimantOf(t), "first");
});

test("another agent's claim on a protected ticket is refused, and the holder is named", async () => {
    const t = ticket("held and worked");
    assert.equal((await claim(FIRST, t)).status, 200);

    const refused = await claim(SECOND, t);

    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(String(refused.json.error), /held by first/);
    assert.equal(claimantOf(t), "first", "the holder keeps it");
    assert.deepEqual(takeOverEvents(t), [], "nothing was taken, so nothing is said");
});

test("past the protection the ticket is taken over, and the thread says so", async () => {
    const t = ticket("claimed, then forgotten");
    assert.equal((await claim(FIRST, t)).status, 200);
    agePast(t, 120);

    const taken = await claim(SECOND, t);

    assert.equal(taken.status, 200, JSON.stringify(taken.json));
    assert.equal(claimantOf(t), "second");
    assert.equal(takeOverEvents(t).length, 1, "said once");
    assert.match(takeOverEvents(t)[0], /second took over the claim held by first/);
});

test("working on the ticket renews the protection", async () => {
    const t = ticket("held and still worked");
    assert.equal((await claim(FIRST, t)).status, 200);
    agePast(t, 120);
    // The holder speaks again: its last action is now.
    const said = await call(FIRST, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "still on it", summary_until: "s", handback: false,
    });
    assert.ok(said.status < 300, JSON.stringify(said.json));

    const refused = await claim(SECOND, t);

    assert.equal(refused.status, 409, "the fresh action protects it again");
});

test("an assignment supersedes a claim, and a human is never restricted", async () => {
    const t = ticket("assigned to the first agent");
    const assigned = await call(HUMAN, "POST", `/api/tickets/${t}/assign`, { assignee: "first" });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json));

    const refused = await claim(SECOND, t);
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), /assignment supersedes a claim/);

    const byHuman = await claim(HUMAN, t);
    assert.equal(byHuman.status, 200, "a human takes what it needs to moderate");
});
