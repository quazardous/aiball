/**
 * #2276 — the Signals tab. What must hold: only a human lists, mints, edits or
 * revokes a signal key and reads a project's signals; a key needs a label and a
 * note, and no two keys share a label; the token leaves the daemon once, at
 * minting; a revoked key can no longer post; a project lists the signals aimed
 * at it or at one of its owners — not another project's — with each recipient's
 * delivery state.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2276-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { listProjectSignals } = await import("../db/signal-keys.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "coder", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
createProject({ name: "p1-2276" });
createProject({ name: "p2-2276" });
upsertSubscription("coder", "p1-2276", "owner");
upsertSubscription("other", "p2-2276", "owner");
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2276-h" }).token;
const CODER = issueToken({ kind: "agent", consumer_id: "coder", label: "2276-c" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Res = { status: number; json: any; text: string };
async function http(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, text };
}
async function mint(label: string, note = `given to ${label} for the tests`): Promise<{ token: string; key_id: string }> {
    const r = await http("POST", "/signal-keys", { label, note }, HUMAN);
    assert.equal(r.status, 201, r.text);
    return { token: r.json.token, key_id: r.json.key.key_id };
}

test("an agent can neither list, mint, edit nor revoke a key, nor read a project's signals", async () => {
    const { key_id } = await mint("agent-probe");
    assert.equal((await http("GET", "/signal-keys", undefined, CODER)).status, 403);
    assert.equal((await http("POST", "/signal-keys", { label: "x", note: "y" }, CODER)).status, 403);
    assert.equal((await http("PATCH", `/signal-keys/${key_id}`, { note: "z" }, CODER)).status, 403);
    assert.equal((await http("DELETE", `/signal-keys/${key_id}`, undefined, CODER)).status, 403);
    assert.equal((await http("GET", "/projects/p1-2276/signals", undefined, CODER)).status, 403);
});

test("minting needs a label and a note, and a label already taken is refused", async () => {
    assert.equal((await http("POST", "/signal-keys", { label: "no-note" }, HUMAN)).status, 400);
    assert.equal((await http("POST", "/signal-keys", { label: "blank-note", note: "   " }, HUMAN)).status, 400);
    assert.equal((await http("POST", "/signal-keys", { note: "no label" }, HUMAN)).status, 400);
    await mint("taken");
    assert.equal((await http("POST", "/signal-keys", { label: "taken", note: "second holder" }, HUMAN)).status, 409);
});

test("the token comes back once, at minting, and never in the list", async () => {
    const { token, key_id } = await mint("once", "given to the chat bridge");
    assert.match(token, /^aiball-[0-9a-f]{48}$/);
    assert.equal(token.includes(key_id), false, "the handle is not a piece of the token");
    const posted = await http("POST", "/signals", { target: { consumer: "coder" }, title: "proves the key works" }, token);
    assert.equal(posted.status, 200);
    const list = await http("GET", "/signal-keys", undefined, HUMAN);
    assert.equal(list.text.includes(token.slice("aiball-".length, "aiball-".length + 12)), false, "no part of the token is listed");
    const row = list.json.find((k: any) => k.key_id === key_id);
    assert.equal(row.note, "given to the chat bridge");
    assert.equal(row.signals_sent, 1);
    assert.ok(row.last_used_at, "posting touched the key");
    assert.equal("token" in row, false);
});

test("the note can be edited but not blanked; an unknown key is a 404", async () => {
    const { key_id } = await mint("editable");
    const edited = await http("PATCH", `/signal-keys/${key_id}`, { note: "now held by the deploy bot" }, HUMAN);
    assert.equal(edited.status, 200);
    assert.equal(edited.json.note, "now held by the deploy bot");
    assert.equal((await http("PATCH", `/signal-keys/${key_id}`, { note: "" }, HUMAN)).status, 400);
    assert.equal((await http("PATCH", "/signal-keys/0000000000000000", { note: "x" }, HUMAN)).status, 404);
    assert.equal((await http("DELETE", "/signal-keys/0000000000000000", undefined, HUMAN)).status, 404);
});

test("a revoked key can no longer post and leaves the list; its signals stay", async () => {
    const { token, key_id } = await mint("revoked-src");
    await http("POST", "/signals", { target: { project: "p1-2276", level: "task" }, title: "sent before revocation" }, token);
    assert.equal((await http("DELETE", `/signal-keys/${key_id}`, undefined, HUMAN)).status, 200);
    assert.equal((await http("POST", "/signals", { target: { consumer: "coder" }, title: "after" }, token)).status, 401);
    const list = await http("GET", "/signal-keys", undefined, HUMAN);
    assert.equal(list.json.some((k: any) => k.key_id === key_id), false);
    const signals = await http("GET", "/projects/p1-2276/signals", undefined, HUMAN);
    assert.ok(signals.json.signals.some((s: any) => s.source === "revoked-src"));
});

test("a project lists what was aimed at it or at its owners, not another project's, with delivery states", async () => {
    const { token } = await mint("scoped-src");
    const post = (target: unknown, title: string) => http("POST", "/signals", { target, title }, token);
    const toProject = await post({ project: "p1-2276", level: "task" }, "to p1");
    await post({ consumer: "coder" }, "to p1's owner");
    await post({ project: "p2-2276", level: "task" }, "to p2");
    await post({ consumer: "other" }, "to p2's owner");

    const listed = await http("GET", "/projects/p1-2276/signals", undefined, HUMAN);
    const titles = listed.json.signals.filter((s: any) => s.source === "scoped-src").map((s: any) => s.title);
    assert.deepEqual(titles, ["to p1's owner", "to p1"], "newest first, the other project's left out");

    const pending = listed.json.signals.find((s: any) => s.id === toProject.json.id);
    assert.deepEqual(pending.deliveries.map((d: any) => [d.recipient, d.state]), [["coder", "pending"]]);
    assert.equal((await http("POST", `/signals/${toProject.json.id}/ack`, {}, CODER)).status, 200);
    const after = await http("GET", "/projects/p1-2276/signals", undefined, HUMAN);
    assert.equal(after.json.signals.find((s: any) => s.id === toProject.json.id).deliveries[0].state, "delivered");

    const later = listProjectSignals("p1-2276", "2999-01-01T00:00:00.000Z");
    const owner = later.find((s) => s.title === "to p1's owner")!;
    assert.equal(owner.deliveries[0].state, "expired", "unacked past its expiry");

    const keys = await http("GET", "/signal-keys?project=p1-2276", undefined, HUMAN);
    const row = keys.json.find((k: any) => k.label === "scoped-src");
    assert.equal(row.signals_sent, 4);
    assert.equal(row.signals_to_project, 2);
});
