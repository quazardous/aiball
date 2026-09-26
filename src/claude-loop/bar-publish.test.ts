// #3030 — the loop pushes its bar as data on change, at most once a second,
// and a burst ends on its last value. Nothing is pushed when nothing changed.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BarRenderer, computeAgentBar } from "./bar-renderer.js";
import { parseAgentBar, type AgentBar } from "../agent-bar.js";

const base = (): AgentBar => ({
    phase: "idle",
    presence: "loop",
    afk: { mode: "off", expires_at: null },
    prompt: { visible: true, has_input: false },
    human_typing: false,
    marker: { info: null, health_prompt: false, resume_picker: false, resume_mode_picker: false },
    alerts: { link_down: false, daemon_down: false, not_logged_in: false, trust_dialog: false, api_unreachable: false },
    proxy_alive: true,
    zen: false,
    counters: null,
    next_wake_at: null,
    boot: null,
});

function renderer(current: { bar: AgentBar }) {
    const sent: AgentBar[] = [];
    const r = new BarRenderer("/nowhere", "t", () => undefined, (b) => sent.push(b), () => current.bar);
    return { r, sent };
}

test("a change is pushed at once; the same bar again is not pushed", () => {
    const current = { bar: base() };
    const { r, sent } = renderer(current);
    r.publishBar(10_000);
    r.publishBar(20_000);
    assert.equal(sent.length, 1, "the same bar twice is one push");
    current.bar = { ...base(), phase: "busy" };
    r.publishBar(30_000);
    assert.deepEqual(sent.map((b) => b.phase), ["idle", "busy"]);
    r.stop();
});

test("a burst inside one second is one push now and one at its end, with the last value", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
    try {
        const current = { bar: base() };
        const { r, sent } = renderer(current);
        r.publishBar(100_000);
        for (const [i, typing] of [[100, true], [200, false], [300, true]] as const) {
            current.bar = { ...base(), human_typing: typing };
            r.publishBar(100_000 + i);
        }
        assert.equal(sent.length, 1, "inside the window, nothing more yet");
        mock.timers.tick(1000);
        assert.equal(sent.length, 2, "the window closed: one trailing push");
        assert.equal(sent[1]!.human_typing, true, "the burst's last value");
        r.stop();
    } finally {
        mock.timers.reset();
    }
});

test("a burst that returns to the pushed value sends nothing at its end", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 200_000 });
    try {
        const current = { bar: base() };
        const { r, sent } = renderer(current);
        r.publishBar(200_000);
        current.bar = { ...base(), human_typing: true };
        r.publishBar(200_100);
        current.bar = base();
        r.publishBar(200_200);
        mock.timers.tick(1000);
        assert.equal(sent.length, 1);
        r.stop();
    } finally {
        mock.timers.reset();
    }
});

test("the loop's own bar is one the daemon accepts, with dates, not countdowns", () => {
    const sd = mkdtempSync(join(tmpdir(), "aiball-3030-sd-"));
    const bar = computeAgentBar(sd, Date.parse("2026-09-26T09:00:00Z"));
    const parsed = parseAgentBar(bar);
    assert.ok(!("error" in parsed), JSON.stringify(parsed));
    for (const d of [bar.afk.expires_at, bar.next_wake_at, bar.boot?.started_at, bar.boot?.deadline_at]) {
        if (d != null) assert.ok(Number.isFinite(Date.parse(d)), `${d} is a date`);
    }
});
