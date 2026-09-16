/**
 * #2640 — the wait credit, over the real routes. What must hold:
 * - an agent starts with 60 minutes per project; a step spends what it waits;
 * - short of credit the wait is capped to the balance, never under 5 minutes,
 *   and the floor never takes the balance below zero; 0 is free;
 * - coming back on the ticket before the end gives the rest back;
 * - a ticket closed on the agent's accepted resolution earns 30, a wontfix 5,
 *   once each;
 * - a commit cited on a reply earns from its changed lines, once, read in the
 *   agent's checkout; unknown, old, unreadable or repeated earns nothing and
 *   says why;
 * - every agent post answers `wait_credit` with the balance; a human has none.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2640-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setConsumerState } = await import("../db/consumers.js");
const { grantWait, refundWait, commitMinutes, waitCreditBalance } = await import("../db/wait-credit.js");
const schema = await import("../schema.js");
const { eq, sql } = await import("drizzle-orm");

const P = "p-2640";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2640-w" }).token;
const BOSS = issueToken({ kind: "agent", consumer_id: "boss", label: "2640-b" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("boss", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const REPO = mkdtempSync(join(tmpdir(), "aiball-2640-repo-"));
after(() => {
    server.close();
    for (const d of [process.env.AIBALL_HOME!, REPO]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Credit = { project: string; balance: number; refunded: number; step?: { requested: number; granted: number; spent: number }; commits?: Array<{ commit: string; minutes: number; reason: string | null }> };
async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
function ticket(): number {
    return submitMessage({ project: P, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
}
async function post(ticketId: number, extra: Record<string, unknown>, token = WORKER): Promise<{ id: number; credit: Credit | undefined }> {
    const r = await call(token, "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return { id: r.json.id as number, credit: r.json.wait_credit as Credit | undefined };
}
async function held(): Promise<number> {
    const t = ticket();
    await call(WORKER, "POST", `/api/tickets/${t}/assign`, {});
    return t;
}
/** The step's wait is over: nothing left to give back. */
function expire(messageId: number): void {
    getDb().run(sql`UPDATE _messages SET meta = json_set(meta, '$.step_resume_at', ${new Date(Date.now() - 60_000).toISOString()}) WHERE id = ${messageId}`);
}

test("pure: the grant, the floor, the refund, a commit's minutes", () => {
    assert.deepEqual(grantWait(45, 60, 5), { requested: 45, granted: 45, spent: 45 });
    assert.deepEqual(grantWait(45, 20, 5), { requested: 45, granted: 20, spent: 20 }, "capped to the balance");
    assert.deepEqual(grantWait(45, 2, 5), { requested: 45, granted: 5, spent: 2 }, "the floor, but never below zero");
    assert.deepEqual(grantWait(45, 0, 5), { requested: 45, granted: 5, spent: 0 });
    assert.deepEqual(grantWait(3, 0, 5), { requested: 3, granted: 3, spent: 0 }, "under the floor, what was asked");
    assert.deepEqual(grantWait(0, 0, 5), { requested: 0, granted: 0, spent: 0 });
    const now = Date.parse("2026-09-16T10:00:00Z");
    assert.equal(refundWait(45, now + 45 * 60_000 - 50, now), 45, "a few ms after the step, the whole wait");
    assert.equal(refundWait(45, now + 20 * 60_000, now), 20);
    assert.equal(refundWait(10, now + 20 * 60_000, now), 10, "never more than was spent");
    assert.equal(refundWait(45, now - 1, now), 0);
    assert.equal(commitMinutes(45, 20, 30), 2);
    assert.equal(commitMinutes(10_000, 20, 30), 30);
    assert.equal(commitMinutes(19, 20, 30), 0);
});

test("a step spends what it waits, the cap and the floor hold, and 0 is free", async () => {
    const t = await held();
    const a = await post(t, { step: true, step_after_minutes: 45 });
    assert.deepEqual(a.credit?.step, { requested: 45, granted: 45, spent: 45 });
    assert.equal(a.credit?.balance, 15);
    expire(a.id);

    const b = await post(t, { step: true, step_after_minutes: 45 });
    assert.deepEqual(b.credit?.step, { requested: 45, granted: 15, spent: 15 }, "capped to what is left");
    assert.equal(b.credit?.balance, 0);
    expire(b.id);

    const c = await post(t, { step: true, step_after_minutes: 45 });
    assert.deepEqual(c.credit?.step, { requested: 45, granted: 5, spent: 0 }, "the floor, free");
    assert.equal(c.credit?.balance, 0, "never below zero");
    const meta = JSON.parse(getDb().select().from(schema.messages).where(eq(schema.messages.id, c.id)).get()!.meta!) as { step_resume_at: string };
    const waits = Math.round((Date.parse(meta.step_resume_at) - Date.now()) / 60_000);
    assert.equal(waits, 5, "the ticket really rests 5 minutes, not 45");
    expire(c.id);

    const d = await post(t, { step: true, step_after_minutes: 0 });
    assert.equal(d.credit?.step, undefined);
    assert.equal(d.credit?.balance, 0);
});

test("coming back before the end gives the rest back, once", async () => {
    // A fresh project, so the balance is the start and not the zero left above.
    const P2 = "p-2640-b";
    createProject({ name: P2 });
    upsertSubscription("worker", P2, "owner");
    const t2 = submitMessage({ project: P2, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
    await call(WORKER, "POST", `/api/tickets/${t2}/assign`, {});
    const step = await call(WORKER, "POST", "/api/messages", { project: P2, kind: "comment_added", ticket_id: t2, body: "b", summary_until: "s", step: true, step_after_minutes: 40 });
    assert.equal((step.json.wait_credit as Credit).balance, 20);
    const back = await call(WORKER, "POST", "/api/messages", { project: P2, kind: "comment_added", ticket_id: t2, body: "done early", summary_until: "s", handback: true });
    assert.equal((back.json.wait_credit as Credit).refunded, 40);
    assert.equal((back.json.wait_credit as Credit).balance, 60);
    const again = await call(WORKER, "POST", "/api/messages", { project: P2, kind: "comment_added", ticket_id: t2, body: "again", summary_until: "s", handback: true });
    assert.equal((again.json.wait_credit as Credit).refunded, 0, "given back once");
    assert.equal((again.json.wait_credit as Credit).balance, 60);
});

test("a ticket closed on the agent's accepted resolution earns 30, a wontfix 5, once", async () => {
    const P3 = "p-2640-c";
    createProject({ name: P3 });
    upsertSubscription("worker", P3, "owner");
    upsertSubscription("boss", P3, "owner");
    async function propose(kind: "resolution" | "wontfix"): Promise<number> {
        const t = submitMessage({ project: P3, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
        const r = await call(WORKER, "POST", "/api/messages", { project: P3, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", decision_kind: kind });
        assert.ok(r.status < 300, JSON.stringify(r.json));
        return r.json.id as number;
    }
    const res = await propose("resolution");
    assert.equal((await call(BOSS, "POST", `/api/messages/${res}/decide`, { status: "accepted" })).status, 200);
    assert.equal(waitCreditBalance("worker", P3), 90);
    const wf = await propose("wontfix");
    assert.equal((await call(BOSS, "POST", `/api/messages/${wf}/decide`, { status: "accepted" })).status, 200);
    assert.equal(waitCreditBalance("worker", P3), 95);
    const rejected = await propose("resolution");
    await call(BOSS, "POST", `/api/messages/${rejected}/decide`, { status: "rejected" });
    assert.equal(waitCreditBalance("worker", P3), 95, "a rejected resolution earns nothing");
    assert.equal(waitCreditBalance("boss", P3), 60, "the human who accepted earns nothing");
    upsertConsumer({ consumer_id: "boss2", kind: "human" });
    upsertSubscription("boss2", P3, "owner");
    const t = submitMessage({ project: P3, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
    const human = submitMessage({ project: P3, kind: "comment_added", ticket_id: t, body: "b", by_agent: "boss2", decision_kind: "resolution" }).id;
    assert.equal((await call(BOSS, "POST", `/api/messages/${human}/decide`, { status: "accepted" })).status, 200);
    assert.equal(waitCreditBalance("boss2", P3), 60, "a human's accepted resolution earns nothing");
});

test("a cited commit earns from its diff once, in the agent's checkout; the rest says why", async () => {
    const git = (args: string[], env: Record<string, string> = {}) => {
        const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(REPO, "a.txt"), Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") + "\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "fresh"]);
    const fresh = git(["rev-parse", "HEAD"]);
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
    writeFileSync(join(REPO, "b.txt"), Array.from({ length: 100 }, (_, i) => `b ${i}`).join("\n") + "\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "old"], { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    const oldSha = git(["rev-parse", "HEAD"]);

    const t = await held();
    const before = waitCreditBalance("worker", P);
    // No known checkout yet: nothing earned, and it says so.
    const blind = await post(t, { handback: true, commits: [fresh.slice(0, 7)] });
    assert.match(blind.credit?.commits?.[0].reason ?? "", /not readable from the daemon/);
    setConsumerState("worker", "idle", false, undefined, REPO, P);

    const r = await post(t, { handback: true, commits: [fresh.slice(0, 7), oldSha, "deadbeef", "not-a-sha"] });
    const [ok, tooOld, unknown, bad] = r.credit!.commits!;
    assert.deepEqual(ok, { commit: fresh.slice(0, 7), minutes: 2, reason: null }, "45 lines / 20 = 2 minutes");
    assert.match(tooOld.reason ?? "", /older than 48 h/);
    assert.match(unknown.reason ?? "", /not a commit in the agent's checkout/);
    assert.match(bad.reason ?? "", /not a commit SHA/);
    assert.equal(r.credit?.balance, before + 2);

    const again = await post(t, { handback: true, commits: [fresh] });
    assert.deepEqual(again.credit?.commits?.[0], { commit: fresh, minutes: 0, reason: "this commit was already counted" });
    assert.equal(again.credit?.balance, before + 2);
});

test("a backlog row carries the asking agent's credit on its project; a human's rows carry none", async () => {
    const t = await held();
    await post(t, { step: true, step_after_minutes: 0 });
    const rows = (await call(WORKER, "GET", `/api/tickets?project=${P}&backlog=1&limit=500`)).json as unknown as Array<{ id: number; backlog_tier: number | null; wait_credit_minutes: number | null }>;
    const row = rows.find((r) => r.id === t)!;
    assert.notEqual(row.backlog_tier, null);
    assert.equal(row.wait_credit_minutes, waitCreditBalance("worker", P));
    const human = (await call(BOSS, "GET", `/api/tickets?project=${P}&backlog=1&limit=500`)).json as unknown as Array<{ wait_credit_minutes: number | null }>;
    assert.ok(human.every((r) => r.wait_credit_minutes === null));
});

test("aiball steps lists every balance", async () => {
    const r = (await call(BOSS, "GET", "/api/steps/timing")).json as { credits: Array<{ consumer_id: string; project: string; balance: number }> };
    const mine = r.credits.find((c) => c.consumer_id === "worker" && c.project === "p-2640-c");
    assert.equal(mine?.balance, 95);
});

test("a human's post carries no wait credit, and commits on a close are refused", async () => {
    const t = ticket();
    const h = await post(t, {}, BOSS);
    assert.equal(h.credit, undefined);
    const r = await call(WORKER, "POST", "/api/messages", { project: P, kind: "ticket_closed", ticket_id: t, commits: ["ef93fbb"] });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /commits only go with a comment/);
});

test("#2645 the consumers list carries each agent's credit per project, and a consumer's page its movements; a human has none", async () => {
    const list = (await call(BOSS, "GET", "/api/consumers")).json as unknown as Array<{ consumer_id: string; wait_credit: Array<{ project: string; balance: number; earned: number }> | null }>;
    const worker = list.find((c) => c.consumer_id === "worker")!;
    const c = worker.wait_credit!.find((r) => r.project === "p-2640-c")!;
    assert.equal(c.balance, 95);
    assert.equal(c.earned, 35);
    assert.equal(list.find((x) => x.consumer_id === "boss")!.wait_credit, null);

    const page = (await call(BOSS, "GET", "/api/consumers/worker/wait-credit")).json as { credits: Array<{ project: string; balance: number }>; moves: Array<{ kind: string; minutes: number; ticket_id: number | null; ref: string | null }> };
    assert.deepEqual(page.credits.map((r) => [r.project, r.balance]).sort(), worker.wait_credit!.map((r) => [r.project, r.balance]).sort(), "the page and the list agree");
    const kinds = new Set(page.moves.map((m) => m.kind));
    for (const k of ["spend", "refund", "earn_resolved", "earn_wontfix", "earn_commit"]) assert.ok(kinds.has(k), `a ${k} movement is listed`);
    assert.ok(page.moves.find((m) => m.kind === "earn_commit")?.ref?.match(/^[0-9a-f]{40}$/), "a commit movement names its SHA");

    const human = (await call(BOSS, "GET", "/api/consumers/boss/wait-credit")).json as { credits: unknown; moves: unknown[] };
    assert.equal(human.credits, null);
    assert.deepEqual(human.moves, []);
    assert.equal((await call(BOSS, "GET", "/api/consumers/nobody/wait-credit")).status, 404);
});
