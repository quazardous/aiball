// #845 Phase B — boot-zone watcher tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CompactConfirmWatcher,
    PickerModeWatcher,
    PickerSessionWatcher,
    ResumingWatcher,
} from "./boot-watchers.js";

const CTX = { nowMs: 0 };

test("PickerSessionWatcher: matches `Resume session` + `Space to preview`", () => {
    const w = new PickerSessionWatcher();
    assert.equal(
        w.observe("  Resume session\n  Space to preview", CTX).visible,
        true,
    );
});

test("PickerSessionWatcher: `Resume session` alone is not enough (splash false-positive guard)", () => {
    const w = new PickerSessionWatcher();
    assert.equal(w.observe("Welcome — Resume session?", CTX).visible, false);
});

test("PickerSessionWatcher: begin fires once on false→true", () => {
    const w = new PickerSessionWatcher();
    let beginCount = 0;
    w.on("begin", () => { beginCount++; });
    w.observe("idle", CTX);
    w.observe("Resume session\nSpace to preview", CTX);
    w.observe("Resume session\nSpace to preview", CTX); // no re-emit
    assert.equal(beginCount, 1);
});

test("PickerModeWatcher: matches any of the 3 mode-line phrases", () => {
    const w = new PickerModeWatcher();
    assert.equal(w.observe("Resume from summary", CTX).visible, true);
    w.reset();
    assert.equal(w.observe("Resume full session as-is", CTX).visible, true);
    w.reset();
    assert.equal(w.observe("Don't ask me again", CTX).visible, true);
});

test("ResumingWatcher: matches `Resuming conversation` when no picker is visible", () => {
    const w = new ResumingWatcher();
    assert.equal(w.observe("Resuming conversation…", CTX).visible, true);
});

test("ResumingWatcher: skipped when a picker is on screen (race during bootstrap)", () => {
    const w = new ResumingWatcher();
    const pane = "Resuming conversation… (later)\n\nResume session\nSpace to preview";
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("CompactConfirmWatcher: y/N at the bottom → true", () => {
    const w = new CompactConfirmWatcher();
    const pane = [
        "(previous content)",
        "",
        "Compact this conversation? [Y/n]",
        "  ❯ Yes",
        "    No",
    ].join("\n");
    assert.equal(w.observe(pane, CTX).visible, true);
});

test("CompactConfirmWatcher: stale match far up scrollback → false (footer-scoped)", () => {
    const w = new CompactConfirmWatcher();
    const pane = [
        "Compact this conversation? [Y/n]",
        ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
        "─".repeat(60),
        "❯ ",
        "─".repeat(60),
        "  ⏵⏵ auto mode on",
    ].join("\n");
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("CompactConfirmWatcher: end fires on the visible→hidden transition", () => {
    const w = new CompactConfirmWatcher();
    let endCount = 0;
    w.on("end", () => { endCount++; });
    w.observe([
        "header",
        "Compact this conversation? [Y/n]",
        "  ❯ Yes",
        "    No",
    ].join("\n"), CTX);
    w.observe("idle prompt", CTX);
    assert.equal(endCount, 1);
});
