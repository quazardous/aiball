// #3017 — `claude_loop.mouse: off` leaves the terminal's mouse alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mouseSetupCommands, parseMouse } from "./mouse-setup.js";

test("on (the default) sets the mouse, the clipboard and the drag-copy, as before", () => {
    assert.deepEqual(mouseSetupCommands("cl-x", true, "wl-copy"), [
        ["set-option", "-t", "cl-x", "mouse", "on"],
        ["set-option", "-t", "cl-x", "set-clipboard", "on"],
        ["bind-key", "-T", "copy-mode", "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-no-clear", "wl-copy"],
    ]);
    assert.deepEqual(mouseSetupCommands("cl-x", true, null).at(-1), ["bind-key", "-T", "copy-mode", "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-no-clear"]);
});

test("off touches neither the mouse nor the copy bindings", () => {
    assert.deepEqual(mouseSetupCommands("cl-x", false, "wl-copy"), []);
});

test("the setting reads on/off and booleans, and ignores anything else", () => {
    assert.equal(parseMouse("on"), true);
    assert.equal(parseMouse("OFF"), false);
    assert.equal(parseMouse(false), false);
    assert.equal(parseMouse(true), true);
    assert.equal(parseMouse("maybe"), undefined);
    assert.equal(parseMouse(undefined), undefined);
});
