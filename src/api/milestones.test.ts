/**
 * #2910 — milestones: a release of a project, and the tickets it holds. A
 * milestone is a ticket of level `milestone`; a ticket belongs to at most one.
 * What must hold, over the real routes:
 * - a human or a cto agent puts a ticket in a milestone; a coder cannot;
 * - the milestone must be a milestone of the same project, not yet released;
 * - list rows and the ticket header say which milestone; `?milestone=` filters;
 *   the milestone's header carries its progress; the project lists its milestones;
 * - releasing (closing) a milestone is refused while it holds an open ticket,
 *   whether by a close or by accepting a resolution — humans included;
 * - a coder reads a milestone but does not write on it (david: "visible en
 *   lecture seule par ceux d'en dessous").
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2910-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { updateConsumer } = await import("../db/consumers.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { applyModeration } = await import("./moderation.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "coder", kind: "agent" });
upsertConsumer({ consumer_id: "cto", kind: "agent" });
updateConsumer("cto", { agent_type: "cto" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2910-h" }).token;
const CODER = issueToken({ kind: "agent", consumer_id: "coder", label: "2910-c" }).token;
const CTO = issueToken({ kind: "agent", consumer_id: "cto", label: "2910-t" }).token;
const P = "p-2910";
createProject({ name: P });
createProject({ name: "p-2910-other" });
upsertSubscription("coder", P, "owner");
upsertSubscription("cto", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
function ticket(title: string, project = P): number {
    const m = submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" });
    if (m.status !== "approved") applyModeration(m as never, "approved", "boss");
    return m.id;
}
function milestone(title: string, project = P): number {
    const id = ticket(title, project);
    getDb().update(schema.tickets).set({ level: "milestone" }).where(eq(schema.tickets.id, id)).run();
    return id;
}
const put = (token: string, id: number, milestone_id: number | null) => call(token, "POST", `/api/tickets/${id}/milestone`, { milestone_id });
const close = (token: string, id: number) =>
    call(token, "POST", "/api/messages", { project: P, kind: "ticket_closed", ticket_id: id, parent_id: id, body: "done" });

test("a human or a cto puts a ticket in a milestone; a coder cannot", async () => {
    const m = milestone("0.1");
    const a = ticket("a task");
    const b = ticket("another task");

    const byCoder = await put(CODER, a, m);
    assert.equal(byCoder.status, 403);
    assert.match(byCoder.json.error, /planning/);

    const byHuman = await put(HUMAN, a, m);
    assert.equal(byHuman.status, 200, JSON.stringify(byHuman.json));
    assert.deepEqual(byHuman.json.milestone, { id: m, title: "0.1", released: false });
    assert.equal((await put(CTO, b, m)).status, 200, "a cto plans too");

    // Out again, then back: at most one milestone, the last one set.
    assert.equal((await put(HUMAN, b, null)).json.milestone, null);
    assert.equal((await put(HUMAN, b, m)).status, 200);
});

test("the milestone must be a milestone of the same project, not yet released", async () => {
    const t = ticket("a task");
    const notMilestone = ticket("a plain ticket");
    assert.match((await put(HUMAN, t, notMilestone)).json.error, /is not a milestone/);
    const elsewhere = milestone("other 0.1", "p-2910-other");
    assert.match((await put(HUMAN, t, elsewhere)).json.error, /is a milestone of p-2910-other/);
    const m = milestone("0.2");
    assert.match((await put(HUMAN, m, milestone("0.3"))).json.error, /is itself a milestone/);
    const released = milestone("0.0");
    assert.equal((await close(HUMAN, released)).status, 201);
    assert.match((await put(HUMAN, t, released)).json.error, /already released/);
});

test("rows, the filter, the header, the progress and the project's list say it", async () => {
    const m = milestone("0.4");
    const a = ticket("in 0.4");
    const b = ticket("also in 0.4");
    const outside = ticket("in no milestone");
    await put(HUMAN, a, m);
    await put(HUMAN, b, m);
    assert.equal((await close(HUMAN, b)).status, 201);

    const rows = (await call(CODER, "GET", `/api/tickets?project=${P}&status=any&limit=500`)).json as any[];
    assert.deepEqual(rows.find((r) => r.id === a)?.milestone, { id: m, title: "0.4", released: false });
    assert.equal(rows.find((r) => r.id === outside)?.milestone, null);
    const filtered = (await call(CODER, "GET", `/api/tickets?project=${P}&milestone=${m}&limit=500`)).json as any[];
    assert.deepEqual(filtered.map((r) => r.id).sort(), [a, b].sort(), "the filter keeps the milestone's tickets, closed ones included");

    assert.deepEqual((await call(CODER, "GET", `/api/tickets/${a}`)).json.ticket.milestone, { id: m, title: "0.4", released: false });
    assert.equal((await call(CODER, "GET", `/api/tickets/${m}`)).json.ticket.level, "milestone", "the header says it is a milestone");
    const progress = (await call(CODER, "GET", `/api/tickets/${m}`)).json.ticket.milestone_progress;
    assert.equal(progress.done, 1);
    assert.equal(progress.open, 1);
    assert.deepEqual(progress.tickets.map((t: any) => [t.id, t.closed]), [[a, false], [b, true]]);

    const listed = (await call(CODER, "GET", `/api/projects/${P}/milestones`)).json.milestones as any[];
    const row = listed.find((x) => x.id === m);
    assert.deepEqual({ released: row.released, done: row.done, open: row.open }, { released: false, done: 1, open: 1 });
});

test("a milestone that still holds an open ticket is not released, by a close or by an accepted resolution", async () => {
    const m = milestone("0.5");
    const a = ticket("still open");
    await put(HUMAN, a, m);

    const refused = await close(HUMAN, m);
    assert.equal(refused.status, 409, "humans included");
    assert.match(refused.json.error, new RegExp(`still holds 1 open ticket \\(#${a}\\)`));

    const resolution = submitMessage({
        project: P, kind: "comment_added", ticket_id: m, parent_id: m, body: "released", by_agent: "cto",
        summary_until: "s", decision_kind: "resolution",
    });
    const accept = await call(HUMAN, "POST", `/api/messages/${resolution.id}/decide`, { status: "accepted" });
    assert.equal(accept.status, 409, "the accept is refused, not left half done");
    assert.match(accept.json.error, /still holds 1 open ticket/);

    assert.equal((await close(HUMAN, a)).status, 201);
    assert.equal((await close(HUMAN, m)).status, 201, "released once nothing is open");
    const listed = (await call(HUMAN, "GET", `/api/projects/${P}/milestones`)).json.milestones as any[];
    assert.equal(listed.find((x) => x.id === m)?.released, true);
});

test("a coder reads a milestone but does not write on it", async () => {
    const m = milestone("0.6");
    assert.equal((await call(CODER, "GET", `/api/tickets/${m}`)).status, 200, "it reads it");
    const comment = await call(CODER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: m, parent_id: m, body: "my opinion", summary_until: "s", handback: true,
    });
    assert.equal(comment.status, 403);
    assert.match(comment.json.error, /read-only for this agent/);
    assert.equal((await close(CODER, m)).status, 403);
    const byCto = await call(CTO, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: m, parent_id: m, body: "scope", summary_until: "s", handback: true,
    });
    assert.equal(byCto.status, 201, JSON.stringify(byCto.json));
});

// #2910 — the backlog works the current release first: at equal tier, the
// project's oldest open milestone, then no milestone, then the later ones.
test("at equal tier the backlog puts the current milestone first and a later one last", async () => {
    const Q = "p-2910-order";
    createProject({ name: Q });
    upsertSubscription("coder", Q, "owner");
    const mk = (title: string) => ticket(title, Q);
    const mkM = (title: string) => milestone(title, Q);
    const later = mkM("1.0");
    const current = mkM("0.1");
    // Created after "1.0" but the oldest by date is what counts: make 0.1 the older one.
    getDb().update(schema.tickets).set({ createdAt: "2020-01-01T00:00:00.000Z" }).where(eq(schema.tickets.id, current)).run();
    const inLater = mk("for 1.0");
    const plain = mk("no milestone");
    const inCurrent = mk("for 0.1");
    await put(HUMAN, inLater, later);
    await put(HUMAN, inCurrent, current);

    const rows = (await call(CODER, "GET", `/api/tickets?project=${Q}&backlog=1&limit=500`)).json as any[];
    const order = rows.filter((r) => [inLater, plain, inCurrent].includes(r.id)).map((r) => r.id);
    assert.deepEqual(order, [inCurrent, plain, inLater], JSON.stringify(rows.map((r) => [r.id, r.backlog_tier, r.milestone?.title])));
});
