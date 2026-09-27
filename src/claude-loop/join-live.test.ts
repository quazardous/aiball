// #3166 — claude-loop where the loop already runs: a copy by default, the controls with --force, never a second loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLiveLoop } from "./join-live.js";

const live = { name: "cl-x", place: "host" as const };

test("on a terminal: a read-only copy by default, saying --force takes the controls", () => {
    const v = joinLiveLoop({ force: false, attach: true, tty: true }, live);
    assert.equal(v.kind, "attach");
    assert.equal(v.kind === "attach" && v.readonly, true);
    assert.match(v.message, /read-only/);
    assert.match(v.message, /--force/);
    assert.match(v.message, /session host/);
});

test("--force: the controls, shared", () => {
    const v = joinLiveLoop({ force: true, attach: true, tty: true }, { name: "cl-x", place: "tmux" });
    assert.deepEqual([v.kind, v.kind === "attach" && v.readonly], ["attach", false]);
    assert.match(v.message, /in tmux/);
});

test("no terminal, or --no-attach: refused, even with --force — nothing starts a second loop", () => {
    for (const o of [{ attach: true, tty: false }, { attach: false, tty: true }]) {
        for (const force of [false, true]) {
            const v = joinLiveLoop({ force, ...o }, live);
            assert.equal(v.kind, "refuse", JSON.stringify({ force, ...o }));
            assert.match(v.message, /claude-loop attach cl-x/);
        }
    }
});
