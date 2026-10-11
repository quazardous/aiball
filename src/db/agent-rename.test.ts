// #3760 — renaming an agent: its id rewritten everywhere, history included; onto an existing agent, merged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3760-"));
process.env.AIBALL_SOCK = "";
const { createProject, upsertConsumer, getConsumer } = await import("../db.js");
const { upsertSubscription } = await import("./subscriptions.js");
const { submitMessage } = await import("../messages.js");
const { setTicketClaim } = await import("./tickets.js");
const { issueToken } = await import("./tokens.js");
const { getDb } = await import("./connection.js");
const { sql } = await import("drizzle-orm");
const { AGENT_ID_COLUMNS, agentRenameFacts, renameAgent } = await import("./agent-rename.js");
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

createProject({ name: "p3760" });
upsertConsumer({ consumer_id: "boss", kind: "human" });
const count = (t: string, c: string, id: string) => getDb().get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${id}`)!.n;
const leftAnywhere = (id: string) => AGENT_ID_COLUMNS.filter(([t, c]) => count(t, c, id) > 0).map(([t, c]) => `${t}.${c}`);

/** An agent with a history: a ticket it filed and holds, a comment, a subscription, a token. */
function agentWithHistory(id: string): number {
    upsertConsumer({ consumer_id: id, kind: "agent" });
    upsertSubscription(id, "p3760", "owner");
    issueToken({ kind: "agent", consumer_id: id, label: `t-${id}` });
    const t = submitMessage({ project: "p3760", kind: "ticket_created", title: `by ${id}`, body: "b", by_agent: id }).id;
    submitMessage({ project: "p3760", kind: "comment_added", ticket_id: t, parent_id: t, body: "c", summary_until: "s", handback: true, by_agent: id } as never);
    setTicketClaim(t, id);
    return t;
}

test("every column that holds an agent id is renamed, history included; nothing stays under the old name", () => {
    const t = agentWithHistory("old-agent");
    const before = agentRenameFacts("old-agent", "new-agent");
    assert.ok(before.rows["_messages.by_agent"] >= 1 && before.rows["tickets.by_agent"] === 1 && before.rows["tickets.claimant"] === 1, `the dry run counts what it would change: ${JSON.stringify(before.rows)}`);
    const r = renameAgent("old-agent", "new-agent");
    assert.equal(r.merged, false);
    assert.deepEqual(leftAnywhere("old-agent"), [], "nothing under the old name");
    assert.equal(getConsumer("old-agent"), null);
    assert.equal(getConsumer("new-agent")?.kind, "agent");
    const ticket = getDb().get<{ by_agent: string; claimant: string; last_actor: string }>(sql`SELECT by_agent, claimant, last_actor FROM tickets WHERE id = ${t}`)!;
    assert.deepEqual(ticket, { by_agent: "new-agent", claimant: "new-agent", last_actor: "new-agent" }, "its own ticket, its claim, its last word");
});

test("onto an agent that exists already (renamed by hand): merged, its own record kept, duplicates dropped", () => {
    agentWithHistory("dt-helios");
    upsertConsumer({ consumer_id: "helios", kind: "agent" });
    upsertSubscription("helios", "p3760", "owner");
    const r = renameAgent("dt-helios", "helios");
    assert.equal(r.merged, true);
    assert.deepEqual(leftAnywhere("dt-helios"), []);
    assert.equal(count("subscriptions", "consumer_id", "helios"), 1, "one subscription, not two");
    assert.ok(count("tickets", "claimant", "helios") >= 1, "the claims follow: the renamed agent is not locked out of its own work");
});

test("refused whole: a human, a missing agent, the same name", () => {
    agentWithHistory("a3");
    assert.throws(() => renameAgent("a3", "boss"), /is a human/);
    assert.throws(() => renameAgent("ghost", "x"), /does not exist/);
    assert.throws(() => renameAgent("a3", "a3"), /the same/);
    assert.ok(count("tickets", "by_agent", "a3") > 0, "nothing moved");
});

test("the list of columns covers every column of the schema that names a consumer", () => {
    // A new column holding a consumer id must join AGENT_ID_COLUMNS, or be listed here as not one.
    const NOT_AN_ID = new Set(["consumers.agent_type", "tickets.last_actor_at", "consumers.state_human_word", "consumers.last_seen_at", "consumers.last_seen_ip", "consumers.last_seen_via"]);
    const schema = readFileSync(new URL("../schema.ts", import.meta.url), "utf8");
    const found: string[] = [];
    let table = "";
    for (const line of schema.split("\n")) {
        const t = line.match(/sqliteTable\("([^"]+)"/);
        if (t) table = t[1];
        const c = line.match(/text\("([a-z_]*(?:consumer|agent|claimant|assignee|assigned_by|actor|author|decided_by|created_by|revoked_by|set_by|updated_by|recipient)[a-z_]*)"\)/);
        if (c) found.push(`${table}.${c[1]}`);
    }
    const covered = new Set(AGENT_ID_COLUMNS.map(([t, c]) => `${t}.${c}`));
    assert.deepEqual(found.filter((k) => !covered.has(k) && !NOT_AN_ID.has(k)), []);
});
