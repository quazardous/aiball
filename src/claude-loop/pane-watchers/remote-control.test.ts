// #3291 — Claude in Remote Control: its status line, below the input box, ends
// with `/rc`. Read there only, never from the prompt or the conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteControlWatcher } from "./runtime-watchers.js";

const RULE = "─".repeat(60);
// As a real pane reads (captured from a loop in Remote Control, colours dropped).
const screen = (status: string, prompt = "❯ ") => `some output\n\n${RULE}\n${prompt}\n${RULE}\n  ${status}\n`;
const on = (text: string) => {
    const w = new RemoteControlWatcher();
    w.observe(text, { isBoot: false } as never);
    return w.snapshot().visible;
};

test("the status line ending with /rc: in Remote Control", () => {
    assert.equal(on(screen("⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent                                   /rc")), true);
    assert.equal(on(screen("⏵⏵ auto mode on · 1 shell · esc to interrupt · ← 1 agent · ↓ to manage         /rc")), true, "busy");
});

test("no /rc at the end of the status line: not in Remote Control", () => {
    assert.equal(on(screen("⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent")), false);
    assert.equal(on(screen("? for shortcuts")), false);
});

test("a /rc typed in the prompt, or said up the screen, is not it", () => {
    assert.equal(on(screen("? for shortcuts", "❯ /rc")), false, "typed, not sent");
    assert.equal(on(`the thread says: type /rc\n/rc\n${RULE}\n❯ \n${RULE}\n  ? for shortcuts\n`), false, "above the box");
    assert.equal(on("no box on the screen\n/rc\n"), false, "no box: nothing can be told");
});
