/**
 * #4546 — a rejected ticket reads closed on ticket.list as on ticket.get, and
 * `open` leaves it out, with or without a limit.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4546-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "4546-h" }).token;
const P = "p-4546";
createProject({ name: P });

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const r = await asToken<T>(HUMAN, method, params);
    assert.equal(r.status, 200, method);
    return r.json;
}

const kept = submitMessage({ project: P, kind: "ticket_created", title: "stays open", body: "x", by_agent: "worker" }).id;
const rejected = submitMessage({ project: P, kind: "ticket_created", title: "rejected", body: "x", by_agent: "worker" }).id;
getDb().update(schema.tickets).set({ status: "rejected" }).where(eq(schema.tickets.id, rejected)).run();

type Row = { id: number; closed: boolean };
const rows = (extra: Record<string, unknown>) => get<Row[]>("ticket.list", { project: P, status: "any", ...extra });

test("the list and the read say the same of a rejected ticket", async () => {
    const row = (await rows({})).find((t) => t.id === rejected);
    assert.equal(row?.closed, true, "ticket.list");
    const read = await get<{ ticket: { closed: boolean } }>("ticket.get", { id: rejected });
    assert.equal(read.ticket.closed, true, "ticket.get");
});

test("open leaves a rejected ticket out, with or without a limit", async () => {
    assert.deepEqual((await rows({ open: true })).map((t) => t.id), [kept]);
    assert.deepEqual((await rows({ open: true, limit: 1 })).map((t) => t.id), [kept]);
});
