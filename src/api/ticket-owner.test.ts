/**
 * #3060 — `POST /api/tickets/:id/owner` takes the new owner as `owner`; the
 * old `by_agent` (elsewhere the author) is still read, only when `owner` is
 * absent. Moderator only, as before.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3060-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "alice", kind: "agent" });
upsertConsumer({ consumer_id: "bob", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3060" }).token;
createProject({ name: "p-3060" });
const t = submitMessage({ project: "p-3060", kind: "ticket_created", title: "t", body: "b", by_agent: "boss" }).id;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function setOwner(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}/api/tickets/${t}/owner`, {
        method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}

test("owner sets it; the old by_agent still does; owner wins over it; neither is a 400", async () => {
    const a = await setOwner({ owner: "alice" });
    assert.deepEqual([a.status, a.json.owner, a.json.by_agent], [200, "alice", "alice"]);
    assert.equal(getMessage(t)?.by_agent, "alice");
    assert.equal((await setOwner({ by_agent: "bob" })).status, 200);
    assert.equal(getMessage(t)?.by_agent, "bob", "the old name is still read");
    await setOwner({ owner: "alice", by_agent: "bob" });
    assert.equal(getMessage(t)?.by_agent, "alice", "owner wins");
    assert.equal((await setOwner({})).status, 400);
});
