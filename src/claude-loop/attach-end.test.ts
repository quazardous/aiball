// #3343 — the end of a tmux attach says where the loop went.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterTmuxAttach, attachEndMessage } from "./attach-end.js";

test("still in tmux, moved to the host, or stopped", async () => {
    assert.match(attachEndMessage("cl-a", { tmuxAlive: () => true, onHost: () => false })!, /detached from 'cl-a' — the loop carries on in tmux/);
    assert.match(attachEndMessage("cl-a", { tmuxAlive: () => false, onHost: () => true })!, /moved to aiball's session host/);
    assert.equal(attachEndMessage("cl-a", { tmuxAlive: () => false, onHost: () => false }), null, "not settled yet");
    assert.equal(await afterTmuxAttach("cl-a", { tmuxAlive: () => false, onHost: () => false }, 100, 20), "the loop 'cl-a' stopped");
});

test("a restart that writes its new plate a moment later still reads as moved to the host", async () => {
    let asked = 0;
    const m = await afterTmuxAttach("cl-b", { tmuxAlive: () => false, onHost: () => ++asked >= 3 }, 2000, 10);
    assert.match(m, /moved to aiball's session host/);
});
