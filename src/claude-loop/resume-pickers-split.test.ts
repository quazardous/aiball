// #647 Slice 2 — david `sr9kqw` : claude --resume montre 2 écrans
// distincts (session-list puis summary-mode). Avant, le setter unique
// `setResumePicker(sd, true)` ne disait pas lequel était à l'écran — un
// boot bloqué ne révélait pas la cause via les markers.
//
// #840 `4z59jt` — david "vire tout marker fichier". Les pickers sont IPC
// seul ; on assert sur ipcState au lieu de existsSync(...path).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aiball-647s2-"));

const {
    setResumeSessionPicker,
    setResumeModePicker,
    clearResumePickers,
    setResumePicker,
    readLoopStateInput,
} = await import("./state.js");
const { getIpcState, resetIpcStateForTests } = await import("./ipc-state.js");

function reset(): void { resetIpcStateForTests(); }

test("setResumeSessionPicker mutates the session ipc flag only", () => {
    reset();
    setResumeSessionPicker(dir, true);
    assert.equal(getIpcState().resumeSessionPickerActive, true);
    assert.notEqual(getIpcState().resumeModePickerActive, true);
    setResumeSessionPicker(dir, false);
    assert.equal(getIpcState().resumeSessionPickerActive, false);
});

test("setResumeModePicker mutates the mode ipc flag only", () => {
    reset();
    setResumeModePicker(dir, true);
    assert.equal(getIpcState().resumeModePickerActive, true);
    assert.notEqual(getIpcState().resumeSessionPickerActive, true);
    setResumeModePicker(dir, false);
    assert.equal(getIpcState().resumeModePickerActive, false);
});

test("the two pickers can be active independently", () => {
    reset();
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    assert.equal(getIpcState().resumeSessionPickerActive, true);
    assert.equal(getIpcState().resumeModePickerActive, true);
    clearResumePickers(dir);
});

test("clearResumePickers clears BOTH ipc flags", () => {
    reset();
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    clearResumePickers(dir);
    assert.equal(getIpcState().resumeSessionPickerActive, false);
    assert.equal(getIpcState().resumeModePickerActive, false);
});

test("readLoopStateInput.resumePickerActive = OR(session, mode)", () => {
    reset();
    clearResumePickers(dir);
    assert.equal(readLoopStateInput(dir).resumePickerActive, false);
    setResumeSessionPicker(dir, true);
    assert.equal(readLoopStateInput(dir).resumePickerActive, true, "session-only → true");
    setResumeSessionPicker(dir, false);
    setResumeModePicker(dir, true);
    assert.equal(readLoopStateInput(dir).resumePickerActive, true, "mode-only → true");
    clearResumePickers(dir);
    assert.equal(readLoopStateInput(dir).resumePickerActive, false);
});

test("deprecated setResumePicker(sd, true) maps to session picker (legacy default)", () => {
    reset();
    setResumePicker(dir, true);
    assert.equal(getIpcState().resumeSessionPickerActive, true);
    assert.notEqual(getIpcState().resumeModePickerActive, true);
});

test("deprecated setResumePicker(sd, false) clears BOTH (back-compat)", () => {
    reset();
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    setResumePicker(dir, false);
    assert.equal(getIpcState().resumeSessionPickerActive, false);
    assert.equal(getIpcState().resumeModePickerActive, false);
});

after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});
