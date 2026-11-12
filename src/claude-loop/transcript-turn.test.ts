/**
 * #4616 — a turn open in the transcript, before the UserPromptSubmit hook says so.
 * The lines are the shapes of a real session's transcript.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTurn, TRANSCRIPT_OPEN_MAX_MS, transcriptLineSignal } from "./transcript-turn.js";
import { isBusy, mechanicalProofsLive, PROOF_TRANSCRIPT, seenProof } from "./busy-stack.js";

const dir = mkdtempSync(join(tmpdir(), "aiball-4616-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const f = join(dir, `${n++}.jsonl`); writeFileSync(f, ""); return f; };

const ts = "2026-11-01T07:04:54.014Z";
const prompt = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content }, ...extra }) + "\n";
const toolResult = prompt([{ type: "tool_result", tool_use_id: "x", content: "ok" }]);
const end = (subtype: string) => JSON.stringify({ type: "system", subtype, timestamp: ts }) + "\n";
const queueOp = (operation: string, content?: string) => JSON.stringify({ type: "queue-operation", operation, timestamp: ts, ...(content !== undefined ? { content } : {}) }) + "\n";
const noise = JSON.stringify({ type: "attachment", timestamp: ts }) + "\n";
// #4448 — the main thread at work, in the shapes Claude Code 2.1.319 writes.
const apiRequest = (querySource = "repl_main_thread") => JSON.stringify({ type: "api-request", sessionId: "s", timestamp: ts, version: "2.1.319", querySource }) + "\n";
const assistant = (isSidechain = false) => JSON.stringify({ parentUuid: "p", isSidechain, message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, type: "assistant", timestamp: ts }) + "\n";

/** A poller pinned to the file's real clock: `poll` compares with its mtime. */
const turnOn = (file: string) => new TranscriptTurn(() => file);

test("what opens a turn, what ends one, and what says nothing", () => {
    const kind = (l: string) => transcriptLineSignal(l.trim())?.kind ?? null;
    assert.equal(kind(prompt("Wake up, Neo. look #1")), "prompt");
    assert.equal(kind(prompt("<task-notification> <task-id>a</task-id>")), "notice", "a turn only if work follows");
    assert.equal(kind(prompt("<agent-message from=\"a\"> hi")), "notice");
    assert.equal(kind(prompt("Another Claude session sent a message: <agent-message from=\"a\">")), "prompt", "delivered as a prompt: a turn");
    assert.equal(kind(apiRequest()), "work");
    assert.equal(kind(apiRequest("agent:custom")), null, "a subagent's request");
    assert.equal(kind(assistant()), "work");
    assert.equal(kind(assistant(true)), null, "a subagent's answer");
    assert.equal(kind(prompt([{ type: "text", text: "from a list" }])), "prompt");
    assert.equal(kind(toolResult), null, "a tool result is within a turn");
    assert.equal(kind(prompt("x", { isMeta: true })), null);
    assert.equal(kind(prompt("a subagent's", { isSidechain: true })), null);
    assert.equal(kind(prompt("<command-name>/mcp</command-name>")), null, "no turn follows it");
    assert.equal(kind(prompt("[Request interrupted by user]")), "end", "no Stop follows an interrupt");
    assert.equal(kind(end("stop_hook_summary")), "end");
    assert.equal(kind(end("turn_duration")), "end");
    assert.equal(kind(end("compact_boundary")), null);
    assert.equal(kind(noise), null);
    assert.equal(kind("not json {"), null);
});

test("the 08:04 sequence: the prompt taken by itself holds the loop before its hook, until the turn ends", () => {
    const f = fresh();
    appendFileSync(f, prompt("the turn before") + end("stop_hook_summary") + end("turn_duration"));
    const t = turnOn(f);
    assert.equal(t.poll(Date.now()), false, "the last turn ended: nothing to hold");
    appendFileSync(f, noise + prompt("<task-notification> done"));
    assert.equal(t.poll(Date.now()), false, "#4448 a notification alone may wait for the next prompt");
    appendFileSync(f, apiRequest());
    assert.equal(t.poll(Date.now()), true, "the main thread works on it: no hook has come, the transcript knows");
    appendFileSync(f, toolResult);
    assert.equal(t.poll(Date.now()), true, "still in it");
    appendFileSync(f, end("stop_hook_summary"));
    assert.equal(t.poll(Date.now()), false, "ended");
    assert.equal(t.lastEndMs, Date.parse(ts));
});

test("#4617 a prompt waiting in the queue holds, after the turn's end too, until it is taken", () => {
    const f = fresh();
    appendFileSync(f, end("turn_duration"));
    const t = turnOn(f);
    assert.equal(t.poll(Date.now()), false);
    appendFileSync(f, queueOp("enqueue") + queueOp("enqueue"));
    assert.equal(t.poll(Date.now()), true, "greyed on the screen, the hint or not");
    appendFileSync(f, queueOp("remove"));
    assert.equal(t.poll(Date.now()), true, "one left");
    appendFileSync(f, queueOp("dequeue"));
    assert.equal(t.poll(Date.now()), false, "none left");
    appendFileSync(f, queueOp("remove") + queueOp("enqueue") + queueOp("remove"));
    assert.equal(t.poll(Date.now()), false, "a removal seen without its enqueue never goes below empty");
    const stuck = fresh();
    appendFileSync(stuck, queueOp("enqueue"));
    const q = turnOn(stuck);
    const now = Date.now();
    assert.equal(q.poll(now + TRANSCRIPT_OPEN_MAX_MS + 1_000), false, "a queue that never empties lets go like a turn");
});

test("#4684 task notifications that pass through an idle Claude's queue do not hold it; a prompt among them does", () => {
    const f = fresh();
    // helios, 3 November: the turn ended, four notifications queued, then removed without a turn.
    appendFileSync(f, end("stop_hook_summary") + end("turn_duration"));
    const t = turnOn(f);
    const note = (id: string) => `<task-notification> <task-id>${id}</task-id> done`;
    appendFileSync(f, queueOp("enqueue", note("a")) + queueOp("enqueue", note("b")) + queueOp("enqueue", "<agent-message from=\"x\"> hi"));
    assert.equal(t.poll(Date.now()), false, "notifications alone: Claude is idle");
    appendFileSync(f, queueOp("enqueue", "and also this, typed by david"));
    assert.equal(t.poll(Date.now()), true, "a greyed prompt among them holds");
    appendFileSync(f, queueOp("remove", note("b")) + queueOp("remove", note("a")));
    assert.equal(t.poll(Date.now()), true, "the removals took the notifications, by their text");
    appendFileSync(f, queueOp("remove", "<agent-message from=\"x\"> hi") + queueOp("dequeue"));
    assert.equal(t.poll(Date.now()), false, "the prompt was taken from the head");
    appendFileSync(f, queueOp("enqueue"));
    assert.equal(t.poll(Date.now()), true, "a queued entry that is not text (an image) is a prompt");
});

test("helios, 12 November: a dequeue takes the prompt before the task notifications queued ahead of it", () => {
    const f = fresh();
    appendFileSync(f, end("stop_hook_summary") + end("turn_duration"));
    const t = turnOn(f);
    const note = (id: string) => `<task-notification> <task-id>${id}</task-id> done`;
    appendFileSync(f, queueOp("enqueue", note("a")) + queueOp("enqueue", "egui pop does not know where its config is saved"));
    assert.equal(t.poll(Date.now()), true, "a prompt waits behind a notification");
    appendFileSync(f, queueOp("dequeue"));
    assert.equal(t.poll(Date.now()), false, "the dequeue took the prompt, not the notification at the head");
    appendFileSync(f, queueOp("dequeue"));
    assert.equal(t.poll(Date.now()), false, "with no prompt left, a dequeue takes the head");
});

test("#4448 helios, 8 November: a notification written after the turn's end opens nothing; a prompt does", () => {
    const f = fresh();
    appendFileSync(f, prompt("Another Claude session sent a message: <agent-message from=\"a\">") + apiRequest() + assistant());
    const t = turnOn(f);
    assert.equal(t.poll(Date.now()), true, "a turn at work");
    appendFileSync(f, prompt("<task-notification> <task-id>a</task-id> done"));
    assert.equal(t.poll(Date.now()), true, "a notification within a turn leaves it open");
    appendFileSync(f, noise + end("stop_hook_summary") + end("turn_duration") + prompt("<task-notification> <task-id>a</task-id> done"));
    assert.equal(t.poll(Date.now()), false, "written after the end, with no turn to follow: Claude is idle");
    appendFileSync(f, assistant(true) + apiRequest("agent:custom"));
    assert.equal(t.poll(Date.now()), false, "a subagent at work does not open the main turn");
    appendFileSync(f, prompt("What's up, Doc? look #4839"));
    assert.equal(t.poll(Date.now()), true, "the next prompt opens it");
});

test("attaching mid-turn sees it open; a line cut in two is read once whole", () => {
    const f = fresh();
    appendFileSync(f, end("turn_duration") + prompt("in progress"));
    const t = turnOn(f);
    assert.equal(t.poll(Date.now()), true, "a kernel reloaded mid-turn");
    const line = end("stop_hook_summary");
    appendFileSync(f, line.slice(0, 10));
    assert.equal(t.poll(Date.now()), true, "half a line says nothing");
    appendFileSync(f, line.slice(10));
    assert.equal(t.poll(Date.now()), false);
});

test("a turn that never ends lets go once the file stops moving", () => {
    const f = fresh();
    appendFileSync(f, prompt("then Claude was killed"));
    const t = turnOn(f);
    const now = Date.now();
    assert.equal(t.poll(now), true);
    assert.equal(t.poll(now + TRANSCRIPT_OPEN_MAX_MS - 1_000), true, "a long silence within the bound");
    assert.equal(t.poll(now + TRANSCRIPT_OPEN_MAX_MS + 1_000), false, "past it, no longer held");
    const old = new Date(now - 2 * TRANSCRIPT_OPEN_MAX_MS);
    utimesSync(f, old, old);
    assert.equal(turnOn(f).poll(now), false, "attached to an old open turn: a stuck busy would never end");
});

test("no file, or a file gone: the proof says nothing and nothing throws", () => {
    assert.equal(new TranscriptTurn(() => null).poll(Date.now()), false);
    const f = fresh();
    appendFileSync(f, prompt("x"));
    const t = turnOn(f);
    assert.equal(t.poll(Date.now()), true);
    rmSync(f);
    assert.equal(t.poll(Date.now()), false);
    assert.equal(turnOn(join(dir, "missing.jsonl")).poll(Date.now()), false);
});

test("it holds busy and blocks the pane-idle release, like any proof the screen shows", () => {
    const now = 1_000_000;
    const proofs = seenProof(new Map(), PROOF_TRANSCRIPT, now, 1_500);
    assert.equal(isBusy(proofs, now + 1_000), true);
    assert.equal(mechanicalProofsLive(proofs, now + 1_000), true, "the empty box must not release it");
    assert.equal(isBusy(proofs, now + 2_000), false, "it lets go without the usual 4 s");
});
