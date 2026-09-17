/**
 * #2697 — a moderation rule created the way `aiball rule add` creates it must
 * change what moderation decides. The command used to write the legacy `rules`
 * table, which moderation had stopped reading: the rule was accepted, listed,
 * and had no effect.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2697-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("../db/connection.js");
const { createProject } = await import("../db/projects.js");
const { upsertConsumer } = await import("../db/consumers.js");
const { issueToken } = await import("../db/tokens.js");
const { evaluate } = await import("../rules.js");
const { AiballClient } = await import("../client.js");
const { createApp } = await import("../app.js");

getDb();
createProject({ name: "p2697" });
upsertConsumer({ consumer_id: "mod2697", kind: "human" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const token = issueToken({ kind: "auth", consumer_id: "mod2697", label: "2697" }).token;
const client = new AiballClient({ url, token, home: process.env.AIBALL_HOME, agentId: "mod2697" });

after(() => { server.close(); });

const decide = () => evaluate({ project: "p2697", kind: "comment_added", by_agent: "agent2697" }).decision;

test("aiball rule add / disable / del drive what moderation decides", async () => {
    const baseline = decide();

    const rule = await client.addRule({ decision: "review", match_project: "p2697", match_kind: "comment_added", note: "2697" }) as { id: number };
    assert.equal(decide(), "review", "a rule added by the command is applied");
    const listed = await client.listRules() as Array<{ id: number }>;
    assert.ok(listed.some((r) => r.id === rule.id), "and listed by the command");

    await client.toggleRule(rule.id, false);
    assert.equal(decide(), baseline, "a disabled rule no longer applies");

    await client.toggleRule(rule.id, true);
    await client.deleteRule(rule.id);
    assert.equal(decide(), baseline, "a deleted rule no longer applies");
    assert.ok(!(await client.listRules() as Array<{ id: number }>).some((r) => r.id === rule.id), "nor is it listed");
});

test("the legacy /api/rules route is gone rather than silently accepting", async () => {
    const r = await fetch(`${url}/api/rules`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: "review", match_project: "p2697" }),
    });
    assert.notEqual(r.status, 201);
    assert.ok(r.status >= 400, `expected a refusal, got ${r.status}`);
});
