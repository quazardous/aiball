/**
 * #3461 — the multiplexer called without holding the process: writes kept in
 * order, sessions and clients read from one call each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { muxQueue, muxRun, tmuxClientsAsync, tmuxSessions, type MuxResult } from "./mux-async.js";

const ok = (stdout: string): MuxResult => ({ status: 0, stdout });

test("queued writes land in the order they were asked, however long each takes", async () => {
    const landed: string[] = [];
    // The first write is the slowest: run side by side, it would land last.
    const delays: Record<string, number> = { a: 30, b: 0, c: 10 };
    const q = muxQueue(async ([opt]) => {
        await new Promise((r) => setTimeout(r, delays[opt!]));
        landed.push(opt!);
        return ok("");
    });
    q.push(["a"]); q.push(["b"]); q.push(["c"]);
    await q.idle();
    assert.deepEqual(landed, ["a", "b", "c"]);
});

test("a failed write does not stop the ones after it", async () => {
    const landed: string[] = [];
    const q = muxQueue(async ([opt]) => {
        if (opt === "bad") throw new Error("boom");
        landed.push(opt!);
        return ok("");
    });
    q.push(["a"]); q.push(["bad"]); q.push(["c"]);
    await q.idle();
    assert.deepEqual(landed, ["a", "c"]);
});

test("the sessions that exist come from one ls; no server is none, an error is unknown", async () => {
    const sessions = await tmuxSessions(async (args) => {
        assert.deepEqual(args, ["ls", "-F", "#{session_name}"]);
        return ok("cl-a\ncl-b\r\n\n");
    });
    assert.deepEqual([...sessions!].sort(), ["cl-a", "cl-b"]);
    assert.deepEqual([...(await tmuxSessions(async () => ({ status: 1, stdout: "" })))!], []);
    assert.equal(await tmuxSessions(async () => ({ status: null, stdout: "", error: new Error("ENOENT") })), null);
});

test("a session's clients: how many, and how many have the controls", async () => {
    assert.deepEqual(await tmuxClientsAsync("cl-a", async () => ok("0\n1\n0\n")), { clients: 3, interactive: 2 });
    assert.deepEqual(await tmuxClientsAsync("cl-a", async () => ok("")), { clients: 0, interactive: 0 });
    assert.equal(await tmuxClientsAsync("cl-a", async () => ({ status: 1, stdout: "" })), null);
});

test("a command that cannot start resolves with its error, never rejects", async () => {
    const r = await muxRun(["-V"], "aiball-no-such-multiplexer-3461");
    assert.equal(r.status, null);
    assert.ok(r.error);
});
