/**
 * #2652 david — « il faut que le champ commit soit obligatoire (avec une valeur
 * explicite none ou null) ». What must hold, over the real routes:
 * - an agent's comment without `commits`, from a client that knows the field,
 *   is refused with how to fill it; from an older client it lands with a
 *   warning to reconnect (nothing blocked until it does);
 * - `null`, `"none"` and `[]` say "no commit" and are accepted;
 * - humans, close and reopen are exempt; `tickets.require_commits: false` lifts it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2652-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setConfigOverride } = await import("../db/config-overrides.js");
const schema = await import("../schema.js");

const P = "p-2652";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2652-w" }).token;
const BOSS = issueToken({ kind: "agent", consumer_id: "boss", label: "2652-b" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("boss", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const t = submitMessage({ project: P, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
async function post(extra: Record<string, unknown>, opts: { token?: string; knowsCommits?: boolean; project?: string; ticket?: number } = {}) {
    const r = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${opts.token ?? WORKER}`,
            "content-type": "application/json",
            ...(opts.knowsCommits !== false ? { "x-aiball-client": "commits" } : {}),
        },
        body: JSON.stringify({ project: opts.project ?? P, kind: "comment_added", ticket_id: opts.ticket ?? t, body: "b", summary_until: "s", handback: true, ...extra }),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}

test("an agent's comment without commits is refused, and the reason says how to fill it", async () => {
    const r = await post({});
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /commits is required on an agent's comment/);
    assert.match(String(r.json.error), /commits: null \(or "none"\)/);
});

test("null, \"none\" and [] say no commit; a list of SHAs is taken as before", async () => {
    for (const commits of [null, "none", []]) {
        const r = await post({ commits });
        assert.equal(r.status, 201, `${JSON.stringify(commits)}: ${JSON.stringify(r.json)}`);
        assert.equal(r.json.warnings, undefined);
        assert.equal((r.json.wait_credit as { commits?: unknown }).commits, undefined, "no commit to count");
    }
    const listed = await post({ commits: ["deadbeef"] });
    assert.equal(listed.status, 201);
    assert.equal(((listed.json.wait_credit as { commits: Array<{ commit: string }> }).commits)[0].commit, "deadbeef");
    assert.equal((await post({ commits: "some" })).status, 400, "any other string is not \"none\"");
});

test("a client from before the field is warned, not refused", async () => {
    const r = await post({}, { knowsCommits: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.match(String((r.json.warnings as string[])[0]), /restart the loop \(a new Claude Code session\)/);
});

test("humans, close and reopen are exempt; the project setting lifts the rule", async () => {
    assert.equal((await post({}, { token: BOSS })).status, 201, "a human");
    const close = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json", "x-aiball-client": "commits" },
        body: JSON.stringify({ project: P, kind: "ticket_closed", ticket_id: t }),
    });
    assert.notEqual(close.status, 400, "close is not held to it");
    const closeWithNone = await fetch(`${BASE}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json" },
        body: JSON.stringify({ project: P, kind: "ticket_reopened", ticket_id: t, commits: "none" }),
    });
    assert.equal(closeWithNone.status, 400, "and commits do not go on a lifecycle event");

    const P2 = "p-2652-off";
    createProject({ name: P2 });
    upsertSubscription("worker", P2, "owner");
    const t2 = submitMessage({ project: P2, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
    setConfigOverride(P2, "tickets.require_commits", false);
    const off = await post({}, { project: P2, ticket: t2 });
    assert.equal(off.status, 201, JSON.stringify(off.json));
    assert.equal(off.json.warnings, undefined);
});

test("#2653 the comment keeps its commits in meta: each with its credit, null for none, absent when not sent", async () => {
    const listed = await post({ commits: ["deadbeef", "cafebabe"] });
    const m = JSON.parse(String(listed.json.meta)) as { commits: Array<{ sha: string; minutes: number; reason: string | null }> };
    assert.deepEqual(m.commits.map((c) => c.sha), ["deadbeef", "cafebabe"]);
    assert.ok(m.commits.every((c) => c.minutes === 0 && typeof c.reason === "string"), "unreadable here: no credit, and the reason is kept");
    assert.equal((JSON.parse(String(listed.json.meta)) as { handback?: boolean }).handback, true, "the rest of the meta is kept");

    const none = await post({ commits: "none" });
    assert.equal((JSON.parse(String(none.json.meta)) as { commits: unknown }).commits, null);

    const old = await post({}, { knowsCommits: false });
    assert.equal("commits" in (JSON.parse(String(old.json.meta)) as object), false);

    // Read back from the thread, not just from the post's answer.
    const thread = await fetch(`${BASE}/api/tickets/${t}?full=1`, { headers: { authorization: `Bearer ${BOSS}` } }).then((r) => r.json()) as { comments?: Array<{ id: number; meta: string | null }> };
    const stored = thread.comments?.find((c) => c.id === listed.json.id);
    assert.deepEqual((JSON.parse(String(stored?.meta)) as { commits: Array<{ sha: string }> }).commits.map((c) => c.sha), ["deadbeef", "cafebabe"]);
});

test("#2653 an older client that writes `commits: [...]` as the last body line gets them read as the field", async () => {
    const { commitsFromBody } = await import("../messages.js");
    assert.deepEqual(commitsFromBody("status\n\ncommits: [38e2c869, 1537854e]"), ["38e2c869", "1537854e"]);
    assert.deepEqual(commitsFromBody("x\ncommits: `[\"38e2c869\"]`"), ["38e2c869"]);
    assert.equal(commitsFromBody("x\ncommits: none"), null);
    assert.equal(commitsFromBody("x\ncommits: null"), null);
    assert.equal(commitsFromBody("commits: [38e2c869]\nmore text after"), undefined, "only the last line");
    assert.equal(commitsFromBody("x\ncommits: [not-a-sha]"), undefined);

    const r = await post({ body: "Umbrella status.\n\ncommits: [deadbeef, cafebabe]" }, { knowsCommits: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.warnings, undefined, "said in the body: no warning");
    assert.deepEqual((JSON.parse(String(r.json.meta)) as { commits: Array<{ sha: string }> }).commits.map((c) => c.sha), ["deadbeef", "cafebabe"]);
    assert.match(String(r.json.body), /commits: \[deadbeef, cafebabe\]$/, "the body is left as written");

    const said = await post({ body: "nothing\ncommits: none" }, { knowsCommits: false });
    assert.equal((JSON.parse(String(said.json.meta)) as { commits: unknown }).commits, null);

    // #2660 — a client advertising the field behind a stale tool schema can only write the line: it is read too.
    const declared = await post({ body: "x\ncommits: [deadbeef]" });
    assert.equal(declared.status, 201, JSON.stringify(declared.json));
    assert.deepEqual((JSON.parse(String(declared.json.meta)) as { commits: Array<{ sha: string }> }).commits.map((c) => c.sha), ["deadbeef"]);
    const refused = await post({ body: "no line" });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /only a new Claude Code session does, e\.g\. restarting the loop\), end the body with a line `commits: \[<sha>, <sha>\]` or `commits: none`/, "the refusal gives the way out");
    const withKey = await post({ body: "x\ncommits: [deadbeef]", commits: null });
    assert.equal((JSON.parse(String(withKey.json.meta)) as { commits: unknown }).commits, null, "the key, when sent, wins over the line");
});
