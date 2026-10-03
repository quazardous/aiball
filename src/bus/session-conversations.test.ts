/**
 * #3489 — `session.conversations` lists a folder's Claude Code conversations
 * with the one its loop would resume (`tracked`), and `session.start`'s
 * `resume` refuses, before anything starts, a conversation the folder does not
 * have.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refused, testCaller } from "../tests/lib.js";

const HOME = mkdtempSync("/tmp/aiball-3489-bus-");
process.env.AIBALL_HOME = join(HOME, "aiball");
process.env.AIBALL_SOCK = "";
// Claude Code's own files are under the user's home.
process.env.HOME = HOME;
after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* EPERM on Windows */ } });

const { callMethod } = await import("./methods.js");
await import("./register.js");
const { claudeProjectDir } = await import("../claude-loop/claude-conversations.js");
const { upsertConsumer } = await import("../db.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const boss = testCaller("boss", { kind: "human" });

const cwd = join(HOME, "proj");
mkdirSync(cwd);
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dir = claudeProjectDir(cwd);
mkdirSync(dir, { recursive: true });
const prompt = (s: string) => JSON.stringify({ type: "user", message: { role: "user", content: s } });
writeFileSync(join(dir, `${A}.jsonl`), prompt("first conversation"));
writeFileSync(join(dir, `${B}.jsonl`), prompt("second conversation"));
utimesSync(join(dir, `${A}.jsonl`), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));

interface Listing { tracked: string | null; conversations: Array<{ id: string; first_prompt: string | null; held_by: string | null }> }

test("a folder's conversations, the latest first; tracked is what its loop would resume", async () => {
    const none = await callMethod(boss, "session.conversations", { cwd }) as Listing;
    assert.equal(none.tracked, null, "nothing recorded yet: tvty asks");
    assert.deepEqual(none.conversations.map((c) => [c.id, c.first_prompt, c.held_by]), [[B, "second conversation", null], [A, "first conversation", null]]);
    writeFileSync(join(cwd, ".aiball-session_id"), JSON.stringify({ default: A, agents: { "c-two": B } }));
    assert.equal((await callMethod(boss, "session.conversations", { cwd }) as Listing).tracked, A);
    assert.equal((await callMethod(boss, "session.conversations", { cwd, crew: "c-two" }) as Listing).tracked, B, "a crew agent's own entry");
    assert.equal((await callMethod(boss, "session.conversations", { cwd, limit: 1 }) as Listing).conversations.length, 1);
    writeFileSync(join(cwd, ".aiball-session_id"), JSON.stringify({ default: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", agents: {} }));
    assert.equal((await callMethod(boss, "session.conversations", { cwd }) as Listing).tracked, null, "a recorded id whose transcript is gone resumes nothing");
    assert.deepEqual((await callMethod(boss, "session.conversations", { cwd: join(HOME, "empty") }) as Listing).conversations, []);
});

test("a human's gesture, on this machine", async () => {
    assert.equal((await refused(callMethod(testCaller("worker"), "session.conversations", { cwd }))).code, "MODERATOR_ONLY");
    assert.equal((await refused(callMethod(testCaller("boss", { kind: "human", transport: "tcp" }), "session.conversations", { cwd }))).status, 403);
});

test("session.start's resume: refused before anything starts when the folder has no such conversation", async () => {
    const unknown = await refused(callMethod(boss, "session.start", { cwd, agent: "p-claude", resume: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
    assert.deepEqual([unknown.status, unknown.code], [404, "NOT_FOUND"]);
    assert.match(unknown.message, /no conversation/);
    const empty = await refused(callMethod(boss, "session.start", { cwd: join(HOME, "empty"), agent: "p-claude", resume: "latest" }));
    assert.equal(empty.status, 404);
    assert.equal((await refused(callMethod(boss, "session.start", { cwd, agent: "p-claude", resume: "yesterday" }))).status, 400, "latest or a uuid");
    assert.equal((await refused(callMethod(boss, "session.start", { cwd, name: "term-1", argv: ["sh"], resume: "latest" }))).status, 400, "a terminal runs no Claude");
});
