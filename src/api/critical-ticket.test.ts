/**
 * #2770 — `GET /api/projects/:project/critical`, over the real relations: the
 * project's open ticket holding back the most open tickets, or null.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2770-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2770";
const OTHER = "p-2770-other";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2770-h" }).token;
upsertConsumer({ consumer_id: "lead", kind: "agent" });
const LEAD = issueToken({ kind: "agent", consumer_id: "lead", label: "2770-l" }).token;
createProject({ name: P });
createProject({ name: OTHER });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method: string, path: string, body?: unknown, token: string = HUMAN): Promise<{ status: number; json: any }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
const ticket = (project: string, title: string) =>
    submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
async function relate(on: number, target: number, kind: string): Promise<void> {
    const r = await call("POST", `/api/tickets/${on}/relations`, { target_ticket_id: target, kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}

test("the project's critical ticket counts what it holds down the chain, in any project", async () => {
    assert.equal((await call("GET", `/api/projects/${P}/critical`)).json.critical, null, "nothing held: none");

    const root = ticket(P, "the old blocker");
    const a = ticket(P, "waits on the blocker");
    const b = ticket(OTHER, "waits on it too, from another project");
    const c = ticket(P, "waits on a");
    await relate(a, root, "depends_on");
    await relate(root, b, "blocks");
    await relate(c, a, "depends_on");

    const r = await call("GET", `/api/projects/${P}/critical`);
    assert.equal(r.status, 200);
    assert.equal(r.json.critical?.id, root, JSON.stringify(r.json));
    assert.equal(r.json.critical.holds, 3, "a, b, and c through a");
    assert.equal(r.json.critical.title, "the old blocker");
    assert.equal(r.json.critical.quiet, "", "it moved today");
    assert.equal((await call("GET", `/api/projects/${OTHER}/critical`)).json.critical, null, "the other project holds nothing");

    // Closing a held ticket takes it off the count; below two, no critical ticket.
    submitMessage({ project: OTHER, kind: "ticket_closed", ticket_id: b, by_agent: "boss" });
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: c, by_agent: "boss" });
    assert.equal((await call("GET", `/api/projects/${P}/critical`)).json.critical, null);
});

// #2770 david — "un wake à part après les events et avant le backlog, avec un
// sink : c'est un nouveau tier". The critical ticket leads the backlog of an
// agent whose pool it is in, and sinks like any head once the wake named it.
test("the critical ticket is a tier of its own, ahead of the rest, with the backlog's sink", async () => {
    const Q = "p-2770-tier";
    createProject({ name: Q });
    upsertSubscription("lead", Q, "owner");
    const root = ticket(Q, "the blocker nobody moves");
    const hot = ticket(Q, "an ordinary ticket in my court");
    const w1 = ticket(Q, "held one");
    const w2 = ticket(Q, "held two");
    await relate(w1, root, "depends_on");
    await relate(w2, root, "depends_on");

    const backlog = async (): Promise<any[]> =>
        (await call("GET", `/api/tickets?project=${Q}&backlog=1&limit=500&cooldown_sec=3600`, undefined, LEAD)).json;
    const rows = await backlog();
    assert.equal(rows[0]?.id, root, `the critical ticket heads the backlog: ${JSON.stringify(rows.map((r) => [r.id, r.backlog_tier]))}`);
    assert.equal(rows[0].backlog_tier, -1);
    assert.deepEqual(rows[0].critical, { holds: 2, quiet: "" });
    assert.equal(rows.find((r) => r.id === hot)?.critical, null, "only the critical ticket carries it");
    assert.equal(rows.find((r) => r.id === w1)?.backlog_tier, 4, "what it holds stays blocked");

    // The sink: once a wake named it, it cools like any backlog head.
    const logged = await call("POST", "/api/backlog-wake", { consumer_id: "lead", ticket_id: root }, LEAD);
    assert.equal(logged.status, 200, JSON.stringify(logged.json));
    const after = (await backlog()).find((r) => r.id === root);
    assert.equal(after?.backlog_tier, -1, "still critical");
    assert.ok(after?.backlog_cooled_until, "but sunk until the cooldown ends");
});

// #2770 david — "dans les listes / détail ticket il est possible de flaguer le
// critique ?": the inbox row and the ticket header say it.
test("the web inbox row and the ticket header flag the critical ticket", async () => {
    const R = "p-2770-ui";
    createProject({ name: R });
    const root = ticket(R, "the blocker");
    const w1 = ticket(R, "held one");
    const w2 = ticket(R, "held two");
    await relate(w1, root, "depends_on");
    await relate(w2, root, "depends_on");

    const inbox = (await call("GET", `/api/inbox?project=${R}`)).json;
    const rows: any[] = Array.isArray(inbox) ? inbox : (inbox.rows ?? inbox.tickets ?? inbox.items ?? []);
    assert.deepEqual(rows.find((r) => r.id === root)?.critical, { holds: 2, quiet: "" }, JSON.stringify(inbox).slice(0, 300));
    assert.equal(rows.find((r) => r.id === w1)?.critical, null);

    assert.deepEqual((await call("GET", `/api/tickets/${root}`)).json.ticket.critical, { holds: 2, quiet: "" });
    assert.equal((await call("GET", `/api/tickets/${w1}`)).json.ticket.critical, null);
});
