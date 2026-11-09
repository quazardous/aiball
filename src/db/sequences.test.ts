/**
 * #4866 — the board's numbers come from sequences that check before they hand
 * one out: a number in a node's range, or one a row already has, is refused,
 * named, and the counter does not move. Nothing is skipped over, nothing
 * written over.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "aiball-4866-seq-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer, getDb } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const seq = await import("./sequences.js");
const schema = await import("../schema.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "seq" });
const boss = testCaller("boss", { kind: "human" });
const post = (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number }>;
const ticket = async (title: string) => (await post({ kind: "ticket_created", project: "seq", title, body: "b" })).id;

test("tickets and messages take the sequences' numbers, in order", async () => {
    const db = getDb();
    const t = seq.peek(db, "ticket");
    const a = await ticket("a");
    const b = await ticket("b");
    assert.deepEqual([a, b], [t, t + 1]);
    assert.equal(seq.peek(db, "ticket"), t + 2);
    const m = seq.peek(db, "message");
    assert.ok(m >= 1_000_000, "messages number above the tickets");
    const c = await post({ kind: "comment_added", ticket_id: a, body: "c" });
    assert.equal(c.id, m);
});

test("a next number in a node's range is refused, named, and the counter stays", async () => {
    const db = getDb();
    const at = seq.peek(db, "ticket");
    seq.reserve(db, "ticket", "node-b", at, 1000);
    assert.throws(() => db.transaction((tx) => seq.next(tx as never, "ticket")), (e: unknown) =>
        e instanceof seq.SequenceConflict && /reserved to node-b/.test(e.message) && e.id === at);
    await assert.rejects(ticket("refused"), /reserved to node-b/, "a ticket that would take it is refused");
    assert.equal(seq.peek(db, "ticket"), at, "nothing skipped");
    db.delete(schema.sequenceRanges).run();
});

test("a next number a row already has (brought by a sync) is refused, never written over", async () => {
    const db = getDb();
    const at = seq.peek(db, "ticket");
    db.insert(schema.tickets).values({ id: at, project: "seq", title: "from the master", byAgent: "boss", status: "approved", displaySeq: 999, createdAt: new Date().toISOString() } as never).run();
    assert.equal(seq.conflictOf(db, "ticket", at), "a row already has it");
    await assert.rejects(ticket("refused"), /a row already has it/);
    assert.equal(db.select().from(schema.tickets).all().find((r) => r.id === at)?.title, "from the master", "the synced row stands");
    assert.equal(seq.peek(db, "ticket"), at);
});

test("a range that overlaps another, or starts below the next number, is refused", () => {
    const db = getDb();
    const at = seq.peek(db, "message");
    seq.reserve(db, "message", "node-b", at + 10_000, 1000);
    assert.throws(() => seq.reserve(db, "message", "node-c", at + 10_500, 1000), /overlaps .* node-b/);
    assert.throws(() => seq.reserve(db, "message", "node-c", at - 1, 10), /starts below/);
    assert.deepEqual(seq.reserve(db, "message", "node-c", at + 11_000, 1000), { start: at + 11_000, end: at + 11_999 }, "contiguous is fine");
});

test("the migration moves the counters out of settings as they are, with no jump", () => {
    const sql = readFileSync(new URL("../../drizzle/migrations/0083_sequences.sql", import.meta.url), "utf8");
    const run = (setup: string) => {
        const d = new Database(":memory:");
        d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tickets (id INTEGER PRIMARY KEY); CREATE TABLE _messages (id INTEGER PRIMARY KEY);");
        d.exec(setup);
        for (const stmt of sql.split("--> statement-breakpoint")) d.exec(stmt);
        const rows = Object.fromEntries((d.prepare("SELECT name, next FROM sequences").all() as Array<{ name: string; next: number }>).map((r) => [r.name, r.next]));
        const left = (d.prepare("SELECT count(*) AS n FROM settings WHERE key IN ('next_ticket_id','next_message_id')").get() as { n: number }).n;
        d.close();
        return { rows, left };
    };
    assert.deepEqual(run("INSERT INTO settings VALUES ('next_ticket_id','4870'),('next_message_id','1044700'); INSERT INTO tickets VALUES (4869);"),
        { rows: { ticket: 4870, message: 1044700 }, left: 0 });
    assert.deepEqual(run("INSERT INTO tickets VALUES (7); INSERT INTO _messages VALUES (1000003);"),
        { rows: { ticket: 8, message: 1000004 }, left: 0 }, "no counter in settings: one past the highest row");
    assert.deepEqual(run(""), { rows: { ticket: 1, message: 1_000_000 }, left: 0 }, "an empty board");
});
