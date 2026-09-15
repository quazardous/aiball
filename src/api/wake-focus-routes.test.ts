/**
 * #2525 — a project's wake focus over the real routes. What must hold:
 * - the focus is set and read beside the standing prompt; a mixed or foreign
 *   list is refused and nothing is written;
 * - an owner agent's backlog and unread events keep only the focused tickets,
 *   and an event outside it stays unread, arriving once the focus is lifted;
 * - a human is never filtered; a focus past its end filters nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2525-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { wakeFocusHidesTicket } = await import("../db/backlog-rules.js");
const schema = await import("../schema.js");

const P = "p-2525";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2525-h" }).token;
const LEAD = issueToken({ kind: "agent", consumer_id: "lead", label: "2525-l" }).token;
createProject({ name: P });
upsertSubscription("lead", P, "owner");
upsertSubscription("boss", P, "owner");

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
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
const ticket = (title: string) => submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
const backlog = async (token: string) =>
    ((await call(token, "GET", `/api/tickets?project=${P}&backlog=1&limit=500`)).json as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
const unreadTickets = async () =>
    [...new Set(((await call(LEAD, "GET", `/api/unread?consumer_id=lead&project=${P}&limit=500`)).json.messages as { id: number; ticket_id: number | null; kind: string }[])
        .map((m) => m.kind === "ticket_created" ? m.id : m.ticket_id))].sort((a, b) => (a ?? 0) - (b ?? 0));
const pingCount = async () => (await call(LEAD, "GET", "/api/pings/count?consumer_id=lead")).json.unread as number;
const setFocus = (tickets: string | null, until: string | null = null) =>
    call(HUMAN, "PATCH", `/api/projects/${P}/standing-prompt`, { standing_prompt: "stabilise", focus_tickets: tickets, focus_until: until });

const T1 = ticket("focused");
const T2 = ticket("outside");
const T3 = ticket("outside too");

test("the focus is set and read beside the standing prompt; a mixed or foreign list writes nothing", async () => {
    const ok = await setFocus(`${T1}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.focus_active, true);
    assert.equal(ok.json.focus_line, `focus: #${T1} only`);
    assert.equal(ok.json.standing_prompt, "stabilise");

    const mixed = await setFocus(`${T1}, !${T2}`);
    assert.equal(mixed.status, 400);
    assert.match(mixed.json.error, /mixes/);
    const foreign = await setFocus("999999");
    assert.equal(foreign.status, 400);
    assert.match(foreign.json.error, /not a ticket of p-2525: #999999/);
    assert.equal((await call(HUMAN, "GET", `/api/projects/${P}/standing-prompt`)).json.focus_tickets, `${T1}`, "the refused writes left the focus as it was");
});

test("an owner agent's backlog and events keep the focused ticket; the human sees everything", async () => {
    await setFocus(`${T1}`);
    submitMessage({ project: P, kind: "comment_added", ticket_id: T2, parent_id: T2, body: "news outside the focus", by_agent: "boss", summary_until: "s" });
    submitMessage({ project: P, kind: "comment_added", ticket_id: T1, parent_id: T1, body: "news inside", by_agent: "boss", summary_until: "s" });

    assert.deepEqual(await backlog(LEAD), [T1]);
    assert.deepEqual(await backlog(HUMAN), [T1, T2, T3], "a human is never filtered");
    assert.deepEqual(await unreadTickets(), [T1]);
    assert.equal(wakeFocusHidesTicket("lead", T2), true, "the live ping stream holds it back too");
    assert.equal(wakeFocusHidesTicket("lead", T1), false);
    assert.equal(wakeFocusHidesTicket("boss", T2), false);
    const focusedCount = await pingCount();

    const lifted = await setFocus(null);
    assert.equal(lifted.json.focus_active, false);
    assert.deepEqual(await unreadTickets(), [T1, T2, T3], "the event outside the focus was kept unread, and arrives now");
    assert.ok((await pingCount()) > focusedCount, "the count follows the same filter");
    assert.deepEqual(await backlog(LEAD), [T1, T2, T3]);
});

test("all-but: !T2 leaves just T2 out", async () => {
    await setFocus(`!${T2}`);
    assert.deepEqual(await backlog(LEAD), [T1, T3]);
    assert.equal(wakeFocusHidesTicket("lead", T2), true);
});

test("a focus past its end filters nothing, but the form still shows what was typed", async () => {
    const r = await setFocus(`${T1}`, "2020-01-01T00:00:00Z");
    assert.equal(r.json.focus_active, false);
    assert.equal(r.json.focus_tickets, `${T1}`);
    assert.deepEqual(await backlog(LEAD), [T1, T2, T3]);
    await setFocus(null);
});
