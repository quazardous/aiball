/**
 * #2770 — `project.critical`, over the bus and the real relations: the
 * project's open ticket holding back the most open tickets, or null.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2770-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");

const P = "p-2770";
const OTHER = "p-2770-other";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2770-h" }).token;
upsertConsumer({ consumer_id: "lead", kind: "agent" });
const LEAD = issueToken({ kind: "agent", consumer_id: "lead", label: "2770-l" }).token;
createProject({ name: P });
createProject({ name: OTHER });

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(method: string, params: Record<string, unknown> = {}, token: string = HUMAN): Promise<{ status: number; json: any }> {
    return asToken(token, method, params);
}
const ticket = (project: string, title: string) =>
    submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
async function relate(on: number, target: number, kind: string): Promise<void> {
    const r = await call("ticket.relate", { id: on, target_ticket_id: target, kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}

test("the project's critical ticket counts what it holds down the chain, in any project", async () => {
    assert.equal((await call("project.critical", { project: P })).json.critical, null, "nothing held: none");

    const root = ticket(P, "the old blocker");
    const a = ticket(P, "waits on the blocker");
    const b = ticket(OTHER, "waits on it too, from another project");
    const c = ticket(P, "waits on a");
    await relate(a, root, "depends_on");
    await relate(root, b, "blocks");
    await relate(c, a, "depends_on");

    const r = await call("project.critical", { project: P });
    assert.equal(r.status, 200);
    assert.equal(r.json.critical?.id, root, JSON.stringify(r.json));
    assert.equal(r.json.critical.holds, 3, "a, b, and c through a");
    assert.equal(r.json.critical.title, "the old blocker");
    assert.equal(r.json.critical.quiet, "", "it moved today");
    assert.equal((await call("project.critical", { project: OTHER })).json.critical, null, "the other project holds nothing");

    // Closing a held ticket takes it off the count; below two, no critical ticket.
    submitMessage({ project: OTHER, kind: "ticket_closed", ticket_id: b, by_agent: "boss" });
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: c, by_agent: "boss" });
    assert.equal((await call("project.critical", { project: P })).json.critical, null);
});

// #2770 david — "a separate wake after the events and before the backlog, with a
// sink: it's a new tier". The critical ticket leads the backlog of an
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
        (await call("ticket.list", { project: Q, backlog: true, limit: 500, cooldown_sec: 3600 }, LEAD)).json;
    const rows = await backlog();
    assert.equal(rows[0]?.id, root, `the critical ticket heads the backlog: ${JSON.stringify(rows.map((r) => [r.id, r.backlog_tier]))}`);
    assert.equal(rows[0].backlog_tier, -1);
    assert.deepEqual(rows[0].critical, { holds: 2, quiet: "", quiet_since: rows[0].critical.quiet_since });
    assert.ok(Number.isFinite(Date.parse(rows[0].critical.quiet_since)), "#3514 — since when, as a date");
    assert.equal(rows.find((r) => r.id === hot)?.critical, null, "only the critical ticket carries it");
    assert.equal(rows.find((r) => r.id === w1)?.backlog_tier, 4, "what it holds stays blocked");

    // The sink: once a wake named it, it cools like any backlog head.
    const logged = await call("backlog.record_wake", { consumer_id: "lead", ticket_id: root }, LEAD);
    assert.equal(logged.status, 200, JSON.stringify(logged.json));
    const after = (await backlog()).find((r) => r.id === root);
    assert.equal(after?.backlog_tier, -1, "still critical");
    assert.ok(after?.backlog_cooled_until, "but sunk until the cooldown ends");
});

// #2770 david — "in the lists / ticket detail can we flag the
// critical one?": the inbox row and the ticket header say it.
test("the web inbox row and the ticket header flag the critical ticket", async () => {
    const R = "p-2770-ui";
    createProject({ name: R });
    const root = ticket(R, "the blocker");
    const w1 = ticket(R, "held one");
    const w2 = ticket(R, "held two");
    await relate(w1, root, "depends_on");
    await relate(w2, root, "depends_on");

    const inbox = (await call("inbox.list", { project: R })).json;
    const rows: any[] = inbox.rows;
    const crit = rows.find((r) => r.id === root)?.critical;
    assert.deepEqual(crit, { holds: 2, quiet: "", quiet_since: crit?.quiet_since }, JSON.stringify(inbox).slice(0, 300));
    assert.ok(Number.isFinite(Date.parse(crit!.quiet_since)));
    assert.equal(rows.find((r) => r.id === w1)?.critical, null);

    const got = (await call("ticket.get", { id: root })).json.ticket.critical;
    assert.deepEqual(got, { holds: 2, quiet: "", quiet_since: crit!.quiet_since }, "the same moment on the detail");
    assert.equal((await call("ticket.get", { id: w1 })).json.ticket.critical, null);
});
