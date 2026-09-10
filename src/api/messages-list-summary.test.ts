/**
 * #2198 — `GET /messages?summary=1` drops bodies in the daemon, so poll() no
 * longer ships every pending body across the socket for the MCP process to
 * throw away. The project filter and the limit poll now relies on are pinned
 * here too. Spawns the real app on an ephemeral port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2198-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");

getDb();
upsertConsumer({ consumer_id: "drafter", kind: "agent" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "drafter", label: "2198" }).token;
createProject({ name: "p1" });
createProject({ name: "p2" });

const BODY = "B".repeat(2000);
for (const project of ["p1", "p1", "p2"]) {
    const t = submitMessage({ project, kind: "ticket_created", title: `draft in ${project}`, body: BODY, by_agent: "drafter" });
    if (t.status !== "pending") updateMessageStatus(t.id, "pending", "human", null, "ticket_created");
}

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Row = Record<string, unknown>;
async function list(extra: string): Promise<Row[]> {
    const res = await fetch(`${BASE}/api/messages?kind=ticket_created&status=pending&by_agent=drafter${extra}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Row[];
}

test("summary=1 returns the rows without their bodies", async () => {
    const rows = await list("&summary=1");
    assert.equal(rows.length, 3);
    for (const r of rows) {
        assert.equal("body" in r, false, `row ${r.id} still carries its body`);
        assert.match(String(r.title), /^draft in p[12]$/);
    }
});

test("without summary the bodies are still there — the projection is opt-in", async () => {
    const rows = await list("");
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(String(r.body).length, BODY.length);
});

test("the project filter narrows on the daemon side", async () => {
    const rows = await list("&project=p1&summary=1");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.project === "p1"));
});

test("limit caps the rows the daemon sends", async () => {
    assert.equal((await list("&summary=1&limit=1")).length, 1);
});
