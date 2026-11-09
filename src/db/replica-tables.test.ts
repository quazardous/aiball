/**
 * #4866 — every table of the board is placed once for a replica: in a ticket's
 * or a consumer's document, among the board's tables copied whole, or left out
 * with its reason. A new table placed nowhere fails here, before a replica
 * silently goes without it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4866-tables-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { getRawSqlite, upsertConsumer } = await import("../db.js");
const { DOCUMENTS } = await import("./documents.js");
const { BOARD_TABLES, NOT_COPIED, isDerivedIndex } = await import("./board-tables.js");
const { callMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const { onRevised, reviseTickets } = await import("./doc-revs.js");

test("each table of the database is placed once", () => {
    const tables = (getRawSqlite().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
    const placed = new Map<string, string[]>();
    const note = (t: string, where: string) => placed.set(t, [...(placed.get(t) ?? []), where]);
    for (const [kind, parts] of Object.entries(DOCUMENTS)) for (const p of parts) note(p.table, `${kind} document`);
    for (const b of BOARD_TABLES) note(b.table, "board");
    for (const t of Object.keys(NOT_COPIED)) note(t, "left out");
    const nowhere = tables.filter((t) => !placed.has(t) && !isDerivedIndex(t));
    assert.deepEqual(nowhere, [], "tables a replica would silently go without");
    const twice = [...placed].filter(([t, w]) => w.length > 1 && !(t === "wait_credit_moves" && w.every((x) => x.endsWith("document"))));
    assert.deepEqual(twice, [], "a table in two places (credit moves split by ticket on purpose)");
    const ghosts = [...placed.keys()].filter((t) => !tables.includes(t));
    assert.deepEqual(ghosts, [], "placed tables that do not exist");
});

test("the board's tables come with signatures, and their rows on demand", async () => {
    upsertConsumer({ consumer_id: "boss", kind: "human" });
    const boss = testCaller("boss", { kind: "human" });
    const pull = await callMethod(boss, "replica.pull", { after: 0 }) as { board: Record<string, string> };
    assert.deepEqual(Object.keys(pull.board).sort(), BOARD_TABLES.map((t) => t.table).sort());
    const got = await callMethod(boss, "replica.board", { tables: ["projects", "sequences"] }) as { rows: Record<string, unknown[]> };
    assert.deepEqual(Object.keys(got.rows), ["projects", "sequences"]);
    assert.ok(got.rows.sequences.length >= 3, "ticket, message, rev");
    await assert.rejects(callMethod(boss, "replica.board", { tables: ["tokens"] }), /not a board table/);
});

test("each revision handed out is heard with the last one", () => {
    const heard: number[] = [];
    const stop = onRevised((last) => heard.push(last));
    reviseTickets([1]);
    stop();
    assert.equal(heard.length, 1);
    assert.ok(heard[0] > 0);
});
