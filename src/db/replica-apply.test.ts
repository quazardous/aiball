/**
 * #4867 — a node writes the documents it receives as they are, replaces its
 * copy of a document whole, removes a deleted one, keeps a consumer's own
 * presence, and takes a ticket that names one it does not keep.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4867-apply-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { getRawSqlite, upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const { documentOf } = await import("./documents.js");
const { revOf } = await import("./doc-revs.js");
const { applyDocuments, keeps } = await import("./replica-apply.js");
const { keepWhatIsRead } = await import("../replica-node.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "ap" });
const boss = testCaller("boss", { kind: "human" });
const post = (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number }>;
const db = getRawSqlite();
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

test("a document written back is the same rows; written again, nothing doubles; deleted, it goes", async () => {
    const t = (await post({ kind: "ticket_created", project: "ap", title: "kept", body: "b" })).id;
    await post({ kind: "comment_added", ticket_id: t, body: "one" });
    const doc = documentOf("ticket", String(t), revOf("ticket", t)!);
    const before = JSON.stringify(doc.rows);
    applyDocuments([doc]);
    applyDocuments([doc]);
    assert.equal(JSON.stringify(documentOf("ticket", String(t), 0).rows), before, "the same rows, once");
    assert.ok(keeps("ticket", String(t)));
    applyDocuments([{ ...doc, deleted: true, rows: {} }]);
    assert.equal(keeps("ticket", String(t)), false);
    assert.equal(count(`SELECT count(*) AS n FROM _messages WHERE ticket_id = ?`, t), 0, "what hung off it goes too");
});

test("a ticket naming one the node does not keep is taken all the same", async () => {
    const src = (await post({ kind: "ticket_created", project: "ap", title: "model", body: "b" })).id;
    const doc = documentOf("ticket", String(src), 0);
    const t = { ...doc.rows.tickets[0], id: 900_001, parent_ticket_id: 999_999, display_seq: 900_001 };
    applyDocuments([{ ...doc, key: "900001", deleted: false, rows: { tickets: [t] } }]);
    assert.ok(keeps("ticket", "900001"));
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "the checks are back on after");
});

test("a consumer's document leaves the node's own presence of it as it was", () => {
    db.prepare(`UPDATE consumers SET state = 'busy', cwd = '/here' WHERE consumer_id = 'boss'`).run();
    const doc = documentOf("consumer", "boss", 0);
    applyDocuments([{ ...doc, rows: { ...doc.rows, consumers: [{ ...doc.rows.consumers[0], display_name: "Boss" }] } }]);
    const row = db.prepare(`SELECT display_name, state, cwd FROM consumers WHERE consumer_id = 'boss'`).get() as Record<string, unknown>;
    assert.deepEqual(row, { display_name: "Boss", state: "busy", cwd: "/here" });
});

test("a relayed ticket.get names the ticket to keep", () => {
    const kept: string[] = [];
    const hear = keepWhatIsRead({ keep: (_k: string, key: string) => kept.push(key) } as never);
    hear({ jsonrpc: "2.0", id: 1, method: "ticket.get", params: { id: 42 } });
    hear([{ jsonrpc: "2.0", id: 2, method: "ticket.list", params: {} }, { jsonrpc: "2.0", id: 3, method: "ticket.get", params: { id: 7 } }]);
    assert.deepEqual(kept, ["42", "7"]);
});
