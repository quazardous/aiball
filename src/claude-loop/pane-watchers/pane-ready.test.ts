// #2230 — while Claude Code's trust dialog is on screen the pane is not ready,
// so no wake is typed into it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePaneReady } from "./pane-ready.js";
import { PromptWatcher } from "./runtime-watchers.js";
import { TrustDialogWatcher } from "./boot-watchers.js";
import { TRUST_DIALOG } from "./trust-dialog.fixture.js";

const CTX = { nowMs: 0 };
const QUIET = { pickerSession: false, pickerMode: false, resuming: false, compactConfirm: false, compacting: false };

test("the trap: the prompt watcher reads the trust dialog's chevron as a prompt", () => {
    assert.equal(new PromptWatcher().observe(TRUST_DIALOG, CTX).visible, true);
});

test("on the captured trust dialog the pane is NOT ready", () => {
    const promptVisible = new PromptWatcher().observe(TRUST_DIALOG, CTX).visible;
    const trustDialog = new TrustDialogWatcher().observe(TRUST_DIALOG, CTX).visible;
    assert.equal(composePaneReady({ ...QUIET, promptVisible, trustDialog }), false);
});

test("an ordinary prompt with nothing transient is ready", () => {
    assert.equal(composePaneReady({ ...QUIET, promptVisible: true, trustDialog: false }), true);
});
