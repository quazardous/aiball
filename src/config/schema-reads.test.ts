/**
 * #3250 — the config read through its schema: the global keys (typed, ranged,
 * defaulted), the renames from their one table, `autopoll.throttle` down to 0,
 * and `claude_loop.*_seconds` in the duration notation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-3250-"));
process.env.XDG_CONFIG_HOME = join(root, "xdg");
mkdirSync(join(root, "xdg", "aiball"), { recursive: true });
const { loadConfig, assignWindowSec, upstreamTransportChoice } = await import("../autopoll/config.js");
const { globalConfigValue, _resetFileCache } = await import("./file-reader.js");
const { hotWindowSec } = await import("../queries/inbox-row.js");
after(() => rmSync(root, { recursive: true, force: true }));

function global(yaml: string): void {
    writeFileSync(join(root, "xdg", "aiball", "config.yaml"), yaml);
    _resetFileCache();
}
let n = 0;
function project(yaml: string): string {
    const d = join(root, `p${n++}`);
    mkdirSync(d);
    writeFileSync(join(d, ".aiball.yaml"), yaml);
    return d;
}

test("global keys through the schema: the notation, the default when absent or out of range", () => {
    global("");
    assert.equal(assignWindowSec(), 14400);
    assert.equal(hotWindowSec(), 1200);
    assert.equal(upstreamTransportChoice(), "auto");
    global("assign_window_sec: 2h\nhot_window_sec: 90\nupstream_transport: gh\n");
    assert.equal(assignWindowSec(), 7200, "the duration notation");
    assert.equal(hotWindowSec(), 90, "a bare number is seconds");
    assert.equal(upstreamTransportChoice(), "gh");
    global("assign_window_sec: 30d\nupstream_transport: carrier-pigeon\n");
    assert.equal(assignWindowSec(), 14400, "past its range: the default");
    assert.equal(globalConfigValue("upstream_transport"), "auto", "not an option: the default");
});

test("autopoll.throttle may be 0 (every Stop); the old names from the table, reported; recent_tickets capped by the schema", () => {
    global("");
    assert.equal(loadConfig(project("autopoll:\n  throttle: 0\n")).autopoll.throttle, 0);
    const legacy = loadConfig(project("autopoll:\n  throttle_seconds: 45\n  include_recent_tickets: 99\n"));
    assert.equal(legacy.autopoll.throttle, 45);
    assert.equal(legacy.autopoll.recent_tickets, 20, "the schema's max");
    assert.deepEqual([...legacy.renamed_keys].sort(), ["autopoll.include_recent_tickets → autopoll.recent_tickets", "autopoll.throttle_seconds → autopoll.throttle"]);
    assert.equal(loadConfig(project("autopoll:\n  throttle: 15m\n")).autopoll.throttle, 900);
});

test("claude_loop durations: the notation, and a bare number still seconds", () => {
    global("");
    const c = loadConfig(project("claude_loop:\n  interval_seconds: 1m\n  wake_tempo_seconds: 15\n  boot_grace_seconds: 0\n  presence_hold_seconds: 10m\n")).claude_loop;
    assert.equal(c.interval_seconds, 60);
    assert.equal(c.wake_tempo_seconds, 15);
    assert.equal(c.boot_grace_seconds, 0);
    assert.equal(c.presence_hold_seconds, 600);
    assert.equal(loadConfig(project("claude_loop:\n  interval_seconds: nonsense\n")).claude_loop.interval_seconds, 30, "unreadable: the default");
});
