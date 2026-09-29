/**
 * #3252 — a post on a ticket belongs to the ticket's project: the daemon reads
 * it, a client need not send it, and a project that says otherwise is not kept.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3252-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer, getMessage } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { testCaller } = await import("../tests/lib.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "home-3252" });
createProject({ name: "elsewhere-3252" });
const boss = testCaller("boss", { kind: "human" });
// `run` throws before it returns a promise: async, so a refusal is a rejection.
const post = async (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number; project: string }>;

test("a comment and a close without a project land in the ticket's project", async () => {
    const t = await post({ kind: "ticket_created", project: "home-3252", title: "t", body: "b" });
    const c = await post({ kind: "comment_added", ticket_id: t.id, body: "hello" });
    assert.equal(getMessage(c.id)?.project, "home-3252");
    const closed = await post({ kind: "ticket_closed", ticket_id: t.id });
    assert.equal(getMessage(closed.id)?.project, "home-3252");
});

test("a project that says otherwise is not kept", async () => {
    const t = await post({ kind: "ticket_created", project: "home-3252", title: "t2", body: "b" });
    const c = await post({ kind: "comment_added", project: "elsewhere-3252", ticket_id: t.id, body: "hello" });
    assert.equal(getMessage(c.id)?.project, "home-3252");
});

test("a post on a ticket that does not exist is refused as such", async () => {
    await assert.rejects(post({ kind: "comment_added", ticket_id: 987_654, body: "x" }), (e: { status: number; code: string }) => e.status === 404 && e.code === "TICKET_NOT_FOUND");
});

test("a new ticket still needs its project", async () => {
    await assert.rejects(post({ kind: "ticket_created", title: "t", body: "b" }), (e: { code: string }) => e.code === "FIELD_REQUIRED");
});
