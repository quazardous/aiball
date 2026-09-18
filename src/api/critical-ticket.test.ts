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
const schema = await import("../schema.js");

const P = "p-2770";
const OTHER = "p-2770-other";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2770-h" }).token;
createProject({ name: P });
createProject({ name: OTHER });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${HUMAN}`, ...(body ? { "content-type": "application/json" } : {}) },
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
