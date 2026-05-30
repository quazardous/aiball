// #647 Slice 2 — david `sr9kqw` : claude --resume montre 2 écrans
// distincts (session-list puis summary-mode). Avant, le setter unique
// `setResumePicker(sd, true)` ne disait pas lequel était à l'écran — un
// boot bloqué ne révélait pas la cause via les markers.
//
// Pinned : (a) deux setters distincts écrivent deux marker files
// distincts ; (b) `clearResumePickers` les efface tous deux ;
// (c) `readLoopStateInput.resumePickerActive` est OR(session, mode)
// pour back-compat avec les consommateurs existants ; (d) la dépréciée
// alias `setResumePicker` continue de fonctionner.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aiball-647s2-"));

const {
    setResumeSessionPicker,
    setResumeModePicker,
    clearResumePickers,
    setResumePicker,
    resumeSessionPickerActivePath,
    resumeModePickerActivePath,
    readLoopStateInput,
} = await import("./state.js");

test("setResumeSessionPicker writes/removes its own file only", () => {
    setResumeSessionPicker(dir, true);
    assert.ok(existsSync(resumeSessionPickerActivePath(dir)), "session file present");
    assert.ok(!existsSync(resumeModePickerActivePath(dir)), "mode file absent");
    setResumeSessionPicker(dir, false);
    assert.ok(!existsSync(resumeSessionPickerActivePath(dir)));
});

test("setResumeModePicker writes/removes its own file only", () => {
    setResumeModePicker(dir, true);
    assert.ok(existsSync(resumeModePickerActivePath(dir)));
    assert.ok(!existsSync(resumeSessionPickerActivePath(dir)));
    setResumeModePicker(dir, false);
    assert.ok(!existsSync(resumeModePickerActivePath(dir)));
});

test("the two pickers can be active independently", () => {
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    assert.ok(existsSync(resumeSessionPickerActivePath(dir)));
    assert.ok(existsSync(resumeModePickerActivePath(dir)));
    clearResumePickers(dir);
});

test("clearResumePickers erases BOTH files", () => {
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    clearResumePickers(dir);
    assert.ok(!existsSync(resumeSessionPickerActivePath(dir)));
    assert.ok(!existsSync(resumeModePickerActivePath(dir)));
});

test("readLoopStateInput.resumePickerActive = OR(session, mode)", () => {
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
    clearResumePickers(dir);
    setResumePicker(dir, true);
    assert.ok(existsSync(resumeSessionPickerActivePath(dir)));
    assert.ok(!existsSync(resumeModePickerActivePath(dir)));
});

test("deprecated setResumePicker(sd, false) clears BOTH (back-compat)", () => {
    setResumeSessionPicker(dir, true);
    setResumeModePicker(dir, true);
    setResumePicker(dir, false);
    assert.ok(!existsSync(resumeSessionPickerActivePath(dir)));
    assert.ok(!existsSync(resumeModePickerActivePath(dir)));
});

after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});
