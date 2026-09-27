// #3165 — the pane-diff typing fallback runs only without a host and without a live proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneDiffGuessesTyping } from "./typing-fallback.js";

test("on the session host, a pane that changes is never typing: the host reports the keys", () => {
    assert.equal(paneDiffGuessesTyping({ hostControl: "/h/control.sock", proxyAlive: () => false }), false);
});

test("under a live proxy, neither", () => {
    assert.equal(paneDiffGuessesTyping({ hostControl: null, proxyAlive: () => true }), false);
});

test("tmux without a proxy: the pane is all there is", () => {
    assert.equal(paneDiffGuessesTyping({ hostControl: null, proxyAlive: () => false }), true);
});
