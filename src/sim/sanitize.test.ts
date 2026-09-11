/**
 * The board simulator loads a copy of the live database; the copy must leave
 * its credentials behind. What must hold:
 * - every kind of secret the schema holds is gone from a sanitized copy, while
 *   the tickets and threads the copy is for stay;
 * - every column of the schema whose name looks secret is either wiped or
 *   classified as not secret, so a new one cannot slip through unnoticed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-sim-sanitize-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("../db/connection.js");
const { issueToken } = await import("../db/tokens.js");
const { setPasswordHash, upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { NOT_SECRET_COLUMNS, SECRET_WIPES, looksSecret, sanitizeCopy } = await import("./sanitize.js");

getDb();
after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const now = new Date().toISOString();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
setPasswordHash("boss", "scrypt$not-a-real-hash");
for (const kind of ["agent", "auth", "node", "signal", "install"] as const) {
    issueToken(kind === "agent" || kind === "auth" ? { kind, consumer_id: kind === "auth" ? "boss" : "worker", label: kind } : { kind, label: kind });
}
createProject({ name: "p-sanitize" });
const ticket = submitMessage({ project: "p-sanitize", kind: "ticket_created", title: "keep me", body: "x", by_agent: "boss" }).id;
submitMessage({ project: "p-sanitize", kind: "comment_added", ticket_id: ticket, body: "keep me too", by_agent: "boss" });

const db = new Database(join(process.env.AIBALL_HOME!, "aiball.db"));
db.prepare("INSERT INTO node_project_config (node_token, project, config_json, updated_at) VALUES (?, ?, ?, ?)").run("node-secret", "p-sanitize", "{}", now);
db.prepare("INSERT INTO node_enrollments (id, code, created_at, expires_at, token) VALUES (?, ?, ?, ?, ?)").run("e1", "123456", now, now, "minted-node-secret");
db.prepare("INSERT INTO ticket_payloads (ticket_id, payload, schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(ticket, "{\"api_key\":\"sk-live\"}", "[]", now, now);

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

test("a sanitized copy keeps its threads and loses every credential", () => {
    const threadsBefore = count("SELECT count(*) AS n FROM _messages");
    assert.ok(count("SELECT count(*) AS n FROM tokens") >= 5, "the fixture holds tokens of every kind");

    sanitizeCopy(db);

    assert.equal(count("SELECT count(*) AS n FROM tokens"), 0, "no token of any kind");
    assert.equal(count("SELECT count(*) AS n FROM consumers WHERE password_hash IS NOT NULL"), 0, "no password");
    assert.equal(count("SELECT count(*) AS n FROM node_project_config"), 0, "no node wiring");
    assert.equal(count("SELECT count(*) AS n FROM node_enrollments"), 0, "no pairing request");
    assert.equal(count("SELECT count(*) AS n FROM ticket_payloads"), 0, "no payload value");
    assert.equal(count("SELECT count(*) AS n FROM tickets WHERE id = " + ticket), 1, "the ticket stays");
    assert.equal(count("SELECT count(*) AS n FROM _messages"), threadsBefore, "the thread stays");
    assert.equal(count("SELECT count(*) AS n FROM consumers"), 2, "the consumers stay, without their logins");
});

test("every secret-looking column of the schema is wiped or classified", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map((t) => t.name);
    const unclassified: string[] = [];
    for (const table of tables) {
        const wipe = SECRET_WIPES.find((w) => w.table === table);
        for (const { name } of db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]) {
            if (!looksSecret(name)) continue;
            const wiped = wipe && (wipe.clear === "rows" || wipe.clear.includes(name));
            if (!wiped && !(`${table}.${name}` in NOT_SECRET_COLUMNS)) unclassified.push(`${table}.${name}`);
        }
    }
    assert.deepEqual(unclassified, [], "wipe these in SECRET_WIPES, or say in NOT_SECRET_COLUMNS why they are not secret");
});
