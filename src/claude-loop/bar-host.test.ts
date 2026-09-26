// #3044 — another host draws the bar: tmux's status line goes off, nothing is
// painted into it, and the bar is still published — with its host. Back to
// tmux: the line comes back, painted whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BarRenderer, barHostTransition, computeAgentBar } from "./bar-renderer.js";
import { readBarHost, writeBarHost } from "./state.js";
import type { AgentBar } from "../agent-bar.js";

test("the transition: external turns the line off, back to tmux turns it on and repaints, a first tmux reading does nothing", () => {
    assert.deepEqual(barHostTransition(null, "tmux"), { status: null, repaint: false });
    assert.deepEqual(barHostTransition(null, "external"), { status: "off", repaint: false });
    assert.deepEqual(barHostTransition("tmux", "external"), { status: "off", repaint: false });
    assert.deepEqual(barHostTransition("external", "tmux"), { status: "on", repaint: true });
    assert.deepEqual(barHostTransition("external", "external"), { status: null, repaint: false });
});

test("the state file: absent or anything else is tmux", () => {
    const sd = mkdtempSync(join(tmpdir(), "aiball-3044-"));
    assert.equal(readBarHost(sd), "tmux");
    writeBarHost(sd, "external");
    assert.equal(readBarHost(sd), "external");
    writeBarHost(sd, "tmux");
    assert.equal(readBarHost(sd), "tmux");
});

test("the renderer: external paints nothing into tmux but still publishes, with its host; back to tmux repaints", () => {
    const sd = mkdtempSync(join(tmpdir(), "aiball-3044-r-"));
    const calls: string[][] = [];
    const published: AgentBar[] = [];
    const r = new BarRenderer(sd, "t", (_cmd, args) => { calls.push(args); return undefined; }, (b) => published.push(b), () => computeAgentBar(sd));
    try {
        writeBarHost(sd, "external");
        r.tick();
        assert.deepEqual(calls, [["set-option", "-t", calls[0]?.[2] ?? "", "status", "off"]], "only the status line goes off");
        assert.equal(published.at(-1)?.host, "external", "the bar is still published, saying who draws it");
        calls.length = 0;
        r.tick();
        assert.deepEqual(calls, [], "nothing painted while external");

        writeBarHost(sd, "tmux");
        r.tick();
        const after = calls as string[][]; // the deepEqual above narrowed `calls` to never[]
        assert.deepEqual(after[0]?.slice(3), ["status", "on"], "the line comes back first");
        assert.ok(after.slice(1).some((a) => a.includes("status-left")), "then it is painted whole");
    } finally {
        r.stop();
    }
});
