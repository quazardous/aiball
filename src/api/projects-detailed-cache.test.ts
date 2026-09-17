/**
 * #2682 — listProjectsDetailed is memoized per (consumer, landscape) and dropped
 * on every write that invalidates the flags cache: counts never lag a write.
 * `&project=` narrows the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2682-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, listProjectsDetailed } = await import("../db/projects.js");
const { upsertConsumer } = await import("../db.js");
const { updateMessageStatus } = await import("../db/messages.js");
const schema = await import("../schema.js");

getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "pa" });
createProject({ name: "pb" });

test("the same answer is served from memory, and a write refreshes it at once", () => {
    const now = Date.now();
    const first = listProjectsDetailed("boss", false, now);
    assert.strictEqual(listProjectsDetailed("boss", false, now + 1000), first, "served from memory within the ceiling");
    const t = submitMessage({ project: "pa", kind: "ticket_created", title: "t", body: "x", by_agent: "boss" });
    updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    const after = listProjectsDetailed("boss", false, now + 2000);
    assert.notStrictEqual(after, first, "a write dropped the memo");
    assert.equal(after.find((p) => p.name === "pa")?.open_count, 1, "and the new ticket is counted");
    assert.notStrictEqual(listProjectsDetailed("boss", false, now + 2000 + 5000), after, "past the ceiling, recomputed");
});

test("the route narrows to one project with &project=", async () => {
    const { createApp } = await import("../app.js");
    const server = createApp().listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
        const { issueToken } = await import("../db/tokens.js");
        const tok = issueToken({ kind: "agent", consumer_id: "boss", label: "2682" }).token;
        const r = await fetch(`http://127.0.0.1:${port}/api/projects?detailed=1&project=pb`, { headers: { authorization: `Bearer ${tok}` } });
        const rows = await r.json() as Array<{ name: string }>;
        assert.deepEqual(rows.map((p) => p.name), ["pb"]);
        const all = await (await fetch(`http://127.0.0.1:${port}/api/projects?detailed=1`, { headers: { authorization: `Bearer ${tok}` } })).json() as Array<{ name: string }>;
        assert.ok(all.length >= 2);
    } finally {
        server.close();
    }
});
