/**
 * #3074 — the loop's side of a restart for an update: the banner is seen in
 * Claude's footer only, the bar says so (and a loop started before the field
 * existed still parses), the note a restart leaves is taken once, and the
 * restart resumes the conversation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cl-3074-"));
process.env.CLAUDE_LOOP_STATE_ROOT = root;
after(() => rmSync(root, { recursive: true, force: true }));

const { UpdateInstalledWatcher } = await import("./pane-watchers/runtime-watchers.js");
const { parseAgentBar } = await import("../agent-bar.js");
const { afterRestartNotePath, takeAfterRestartNote } = await import("./state.js");
const { restartStartArgs } = await import("./cmds/manage.js");

const CTX = { nowMs: 0 };

const RULE = "─".repeat(60);
/** A pane as Claude draws it: output above the input box, the footer below it. */
const pane = (above: string[], footer: string[]) => [...above, RULE, "❯ ", RULE, ...footer].join("\n");

test("the update banner in Claude's footer, below the input box, is seen", () => {
    const w = new UpdateInstalledWatcher();
    assert.equal(w.observe(pane(["some output"], ["  ? for shortcuts                  ✓ Update installed · Restart to update"]), CTX).visible, true);
});

test("#3164 — the words in Claude's reply, just above the box, are not", () => {
    const quoted = pane(["● The footer says:", "  ✓ Update installed · Restart to update", "  so a restart is offered."], ["  ? for shortcuts"]);
    assert.equal(new UpdateInstalledWatcher().observe(quoted, CTX).visible, false);
    const far = pane(["I read that it says Update installed · Restart to update", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)], []);
    assert.equal(new UpdateInstalledWatcher().observe(far, CTX).visible, false, "far above the footer");
});

test("a pane with no input box: nothing to tell the footer from the conversation, so no banner", () => {
    assert.equal(new UpdateInstalledWatcher().observe("some output\n\n  ✓ Update installed · Restart to update\n  /rc", CTX).visible, false);
});

test("the bar carries alerts.restart_needed; a bar without it (an older loop) reads false", () => {
    const bar = {
        v: 1,
        phase: "idle", presence: "loop",
        afk: { mode: "off", expires_at: null },
        prompt: { visible: true, has_input: false },
        human_typing: false,
        marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
        alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false },
        proxy_alive: true, zen: false, counters: null, next_wake_at: null, boot: null,
    };
    const older = parseAgentBar(bar);
    assert.ok(!("error" in older), JSON.stringify(older));
    assert.equal((older as { alerts: { restart_needed: boolean } }).alerts.restart_needed, false);
    const newer = parseAgentBar({ ...bar, alerts: { ...bar.alerts, restart_needed: true } });
    assert.equal((newer as { alerts: { restart_needed: boolean } }).alerts.restart_needed, true);
    assert.ok("error" in parseAgentBar({ ...bar, alerts: { ...bar.alerts, restart_needed: "yes" } }));
});

test("the note a restart leaves is taken once, from beside the state dir", () => {
    assert.equal(afterRestartNotePath("agent-x"), join(root, "agent-x.after-restart"));
    assert.equal(takeAfterRestartNote("agent-x"), false);
    writeFileSync(afterRestartNotePath("agent-x"), "{}");
    assert.equal(takeAfterRestartNote("agent-x"), true);
    assert.equal(takeAfterRestartNote("agent-x"), false, "once");
});

test("a restart for an update resumes the conversation; a plain one keeps the start config", () => {
    const plate = { cwd: "/w", check_cmd: "true", claude_args: ["--model", "x"] } as never;
    const plain = restartStartArgs("agent-x", plate);
    const resumed = restartStartArgs("agent-x", plate, { resume: true });
    assert.ok(!plain.includes("--resume"));
    assert.ok(resumed.includes("--resume"));
    assert.ok(resumed.indexOf("--resume") < resumed.indexOf("--"), "a start option, not a claude arg");
});
