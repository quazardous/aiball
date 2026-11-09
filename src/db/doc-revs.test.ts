/**
 * #4866 — a document (a ticket, a consumer) takes a new revision each time
 * something about it changes, and a replica pulls the documents revised after
 * its cursor, each one whole.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4866-rev-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { getMethod, callMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const docRevs = await import("./doc-revs.js");
const { lastRev } = docRevs;
const revOf = (id: number) => docRevs.revOf("ticket", id);
const consumerRev = (id: string) => docRevs.revOf("consumer", id);
const { rowsHash } = await import("./documents.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "rev" });
(await import("./subscriptions.js")).upsertSubscription("worker", "rev", "owner");
const boss = testCaller("boss", { kind: "human" });
const worker = testCaller("worker");
const post = (caller: ReturnType<typeof testCaller>, p: Record<string, unknown>) => getMethod("message.post")!.run(caller, p) as Promise<{ id: number }>;
const ticket = async (title: string) => (await post(boss, { kind: "ticket_created", project: "rev", title, body: "b" })).id;

type Doc = { kind: "ticket" | "consumer"; key: string; rev: number; deleted: boolean; rows: Record<string, Array<Record<string, unknown>>>; hash: string };
type Pull = { last: number; documents: Doc[] };
const pull = (after: number, caller = boss, limit?: number) => callMethod(caller, "replica.pull", { after, ...(limit ? { limit } : {}) }) as Promise<Pull>;

test("a new ticket has a revision, and each change gives it a newer one", async () => {
    const a = await ticket("a");
    const r0 = revOf(a)!;
    assert.ok(r0 > 0);
    await post(worker, { kind: "comment_added", ticket_id: a, body: "c", summary_until: "s", commits: null, handback: true });
    const r1 = revOf(a)!;
    assert.ok(r1 > r0, "a comment revises it");
    const plan = await post(worker, { kind: "comment_added", ticket_id: a, body: "p", summary_until: "s", commits: null, decision_kind: "plan" });
    await getMethod("message.decide")!.run(boss, { id: plan.id, status: "accepted" });
    assert.ok(revOf(a)! > r1, "a decision revises it");
    assert.equal(lastRev(), Math.max(lastRev(), revOf(a)!));
});

test("a pull after a cursor gives the documents revised since, whole, oldest revision first", async () => {
    const from = lastRev();
    const b = await ticket("b");
    const c = await ticket("c");
    await post(boss, { kind: "comment_added", ticket_id: b, body: "on b" });
    const got = await pull(from);
    const tickets = got.documents.filter((d) => d.kind === "ticket").map((d) => Number(d.key));
    assert.deepEqual(tickets, [c, b], "b's newest revision comes after c's");
    assert.equal(got.last, lastRev());
    const doc = got.documents.find((d) => d.kind === "ticket" && Number(d.key) === b)!;
    assert.equal(doc.deleted, false);
    assert.equal(doc.rows.tickets[0].title, "b");
    assert.ok(doc.rows._messages.some((m) => m.body === "on b"), "its comments come with it");
    assert.equal(doc.hash, rowsHash("ticket", doc.rows), "the hash is the rows'");
    assert.ok(doc.rows.pings.length > 0, "every recipient's pings about it come with it");
    assert.deepEqual((await pull(got.last)).documents, [], "nothing after the last");
    assert.equal((await pull(from, boss, 1)).documents.length, 1, "a limit holds");
});

test("a consumer's document leaves its live presence out", async () => {
    const { setConsumerState } = await import("./consumers.js");
    const before = consumerRev("worker");
    setConsumerState("worker", "busy" as never, false, undefined, "/tmp/elsewhere", "rev");
    assert.equal(consumerRev("worker"), before, "a presence report does not revise it");
    const doc = (await pull(0)).documents.find((d) => d.kind === "consumer" && d.key === "worker")!;
    for (const c of ["state", "last_seen_at", "updated_at"]) assert.equal(c in doc.rows.consumers[0], false, `${c} left out`);
});

test("only a node, or a human on this machine's socket, pulls", async () => {
    await assert.rejects(pull(0, worker), /node token/);
    await assert.rejects(pull(0, testCaller("boss", { kind: "human", transport: "tcp" })), /node token/);
    assert.ok((await pull(0, testCaller("worker", { relayed: true }))).documents.length > 0, "through a node");
});

test("every gesture that touches what a ticket's document holds revises it", async () => {
    const t = await ticket("covered");
    await post(worker, { kind: "comment_added", ticket_id: t, body: "w", summary_until: "s", commits: null, handback: true });
    const gestures: Array<[string, () => Promise<unknown>]> = [
        ["subscribe to it", () => callMethod(worker, "ticket.subscribe", { ticket_id: t })],
        ["tag it", () => callMethod(boss, "message.add_tag", { id: t, tag: "bug" })],
        ["mark it read", () => callMethod(boss, "ticket.mark_read", { id: t })],
        ["count its tokens", () => callMethod(boss, "ticket.add_token_usage", { id: t, in: 1, out: 2 })],
        ["note a wake on it", () => callMethod(worker, "backlog.record_wake", { ticket_id: t })],
        ["vote on its comment", async () => {
            const c = await post(worker, { kind: "comment_added", ticket_id: t, body: "v", summary_until: "s", commits: null, handback: true });
            return callMethod(boss, "message.vote", { id: c.id, value: 1 });
        }],
        ["assign it", () => callMethod(boss, "ticket.assign", { id: t, assignee: "worker" })],
        ["snooze it", () => callMethod(boss, "ticket.postpone", { id: t, until: new Date(Date.now() + 3_600_000).toISOString() })],
    ];
    const missed: string[] = [];
    // Each gesture revises the ticket, or the consumer whose state it is.
    const consumerSide = new Set<string>();
    for (const [what, gesture] of gestures) {
        const rev = () => (consumerSide.has(what) ? Math.max(consumerRev("worker") ?? 0, consumerRev("boss") ?? 0) : revOf(t)!);
        const before = rev();
        try { await gesture(); } catch (e) { missed.push(`${what}: failed (${(e as Error).message})`); continue; }
        if (!(rev() > before)) missed.push(what);
    }
    assert.deepEqual(missed, [], "gestures that left the ticket's revision as it was");
});
