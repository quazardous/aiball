/**
 * #2432 david — a relation names the other ticket by number only: the chip in
 * the thread header, and the rows the thread shows for relation events. Hovering
 * should say what that number is. What must hold, over the real route:
 * - each relation of a ticket carries its target's title;
 * - each relation row of the thread carries the other ticket's title.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2432-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const schema = await import("../schema.js");

const P = "p-2432";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2432-h" }).token;
createProject({ name: P });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${HUMAN}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}

test("a relation carries its target's title, and so does the row a close leaves", async () => {
    const waiting = ticket("the ticket that waits");
    const blocker = ticket("the blocker, named in full");
    const related = await call("POST", `/api/tickets/${waiting}/relations`, { target_ticket_id: blocker, kind: "depends_on" });
    assert.equal(related.status, 200, JSON.stringify(related.json));

    const before = await call("GET", `/api/tickets/${waiting}?full=1`);
    const rels = (before.json.ticket as { relations: { target_ticket_id: number; target_title?: string | null }[] }).relations;
    assert.equal(rels.find((r) => r.target_ticket_id === blocker)?.target_title, "the blocker, named in full");

    submitMessage({ project: P, kind: "ticket_closed", ticket_id: blocker, by_agent: "boss" });

    const after = await call("GET", `/api/tickets/${waiting}?full=1`);
    const rows = (after.json.comments as { kind: string; source_ticket_title?: string | null }[]).filter((c) => c.kind === "dependency_closed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_ticket_title, "the blocker, named in full");
});
