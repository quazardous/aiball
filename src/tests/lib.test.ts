// #3241 — the shared test helpers do what the copies did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refused, testCaller, until } from "./lib.js";
import { Refusal } from "../bus/methods.js";

test("until waits for the condition, and fails with its name past the deadline", async () => {
    let n = 0;
    await until("three ticks", () => ++n >= 3, 1000, 1);
    assert.equal(n, 3);
    await assert.rejects(until("never", () => false, 30, 5), /timed out waiting for never/);
});

test("refused returns what was thrown, sync, async or a call, and fails on an answer", async () => {
    assert.equal((await refused(() => { throw new Refusal(409, "no", "CONFLICT"); })).code, "CONFLICT");
    assert.equal((await refused(async () => { throw new Refusal(404, "gone", "NOT_FOUND"); })).status, 404);
    assert.equal((await refused(Promise.reject(new Refusal(403, "not you", "FORBIDDEN")))).code, "FORBIDDEN");
    await assert.rejects(refused(() => 1), /expected a refusal/);
});

test("testCaller: an agent on the local socket by default; a human, a remote, a relayed one on request", () => {
    assert.deepEqual(testCaller("worker"), { consumer_id: "worker", kind: "agent", transport: "uds", relayed: false, token: null, token_kind: "agent" });
    assert.equal(testCaller("boss", { kind: "human" }).token_kind, "auth");
    assert.equal(testCaller("w", { transport: "tcp" }).transport, "tcp");
    assert.equal(testCaller("w", { relayed: true }).token_kind, "node");
});
