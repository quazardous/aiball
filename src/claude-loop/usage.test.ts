/**
 * #3686 — the subscription's usage, from Claude Code's status line to the
 * agent bar: read from `rate_limits` (epoch seconds to ISO dates, a window
 * null when absent), relayed by the loop's own status line, which runs the
 * user's with the same stdin and passes its output and exit code through.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loopStatusLine, sameUsage, usageOf, userStatusLine } from "./usage.js";
import { buildSpawnSettings } from "./spawn-settings.js";
import { getIpcState, resetIpcStateForTests } from "./ipc-state.js";
import { dispatchProxyEvent, formatVerdictLogLine } from "./proxy-event-dispatcher.js";
import { computeAgentBar } from "./bar-renderer.js";
import { offloadPath } from "./offload.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(join(tmpdir(), "usage-3686-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const AT = Date.parse("2026-10-08T09:41:07Z");
const RL = { five_hour: { used_percentage: 23.5, resets_at: 1791460800 }, seven_day: { used_percentage: 41, resets_at: 1791792000 } };

test("read from rate_limits: ISO dates, a window null when absent or malformed, null when none is given", () => {
    assert.deepEqual(usageOf(RL, AT), {
        five_hour: { used_percentage: 23.5, resets_at: "2026-10-08T12:00:00.000Z" },
        seven_day: { used_percentage: 41, resets_at: "2026-10-12T08:00:00.000Z" },
        read_at: "2026-10-08T09:41:07.000Z",
    });
    assert.deepEqual(usageOf({ seven_day: RL.seven_day }, AT)!.five_hour, null, "a window dropped once it reset");
    assert.equal(usageOf({ five_hour: { used_percentage: "23", resets_at: 1 }, seven_day: { used_percentage: 4 } }, AT)!.seven_day, null);
    assert.equal(usageOf(undefined, AT), null, "an API key: no rate_limits at all");
    assert.equal(usageOf(null, AT), null);
});

test("a new reading of the same numbers is not news", () => {
    assert.ok(sameUsage(usageOf(RL, AT), usageOf(RL, AT + 60_000)));
    assert.ok(!sameUsage(usageOf(RL, AT), usageOf({ ...RL, five_hour: { ...RL.five_hour, used_percentage: 24 } }, AT)));
    assert.ok(!sameUsage(null, usageOf(RL, AT)));
    assert.ok(sameUsage(null, null));
});

test("the user's status line: the folder's local settings, then its shared ones, then the user's", () => {
    const cwd = join(dir, "proj");
    const claudeDir = join(dir, "claude-home");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    assert.equal(userStatusLine(cwd, claudeDir), null, "none set");
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "user-line", padding: 1 } }));
    assert.equal(userStatusLine(cwd, claudeDir)!.command, "user-line");
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "shared-line" } }));
    assert.equal(userStatusLine(cwd, claudeDir)!.command, "shared-line");
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ not json");
    assert.equal(userStatusLine(cwd, claudeDir)!.command, "shared-line", "a broken file is skipped");
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "local-line" } }));
    assert.equal(userStatusLine(cwd, claudeDir)!.command, "local-line");
});

test("the loop's status line carries the user's command and keeps its other keys; it is in the settings Claude is spawned with", () => {
    const own = loopStatusLine("tsx status-line.ts", { type: "command", command: "echo 'hi' | x", padding: 2, refreshInterval: 30 });
    assert.equal(own.command, `tsx status-line.ts ${Buffer.from("echo 'hi' | x").toString("base64")}`);
    assert.deepEqual([own.type, own.padding, own.refreshInterval], ["command", 2, 30]);
    assert.deepEqual(loopStatusLine("tsx status-line.ts", null), { type: "command", command: "tsx status-line.ts" });
    assert.deepEqual(buildSpawnSettings({}, [], own), { hooks: {}, statusLine: own });
    assert.deepEqual(buildSpawnSettings({}, ["Read"]), { hooks: {}, permissions: { deny: ["Read"] } }, "without one, as before");
});

test("a reading reaches the agent bar; null replaces it when Claude Code gives none", () => {
    resetIpcStateForTests();
    const sd = join(dir, "sd-bar");
    mkdirSync(sd);
    const v = dispatchProxyEvent(sd, { event: "hook", kind: "StatusLine", rate_limits: RL, at_ms: AT });
    assert.equal(v.kind, "usage-read");
    assert.equal(formatVerdictLogLine(v), "proxy-event: usage 5h=23.5% 7d=41%");
    assert.deepEqual(computeAgentBar(sd).usage, usageOf(RL, AT));
    const again = dispatchProxyEvent(sd, { event: "hook", kind: "StatusLine", rate_limits: RL, at_ms: AT + 1000 });
    assert.deepEqual([again.kind, (again as { changed: boolean }).changed], ["usage-read", false]);
    assert.equal(getIpcState().usage!.read_at, new Date(AT + 1000).toISOString(), "the freshest reading is kept");
    dispatchProxyEvent(sd, { event: "hook", kind: "StatusLine", at_ms: AT + 2000 });
    assert.equal(computeAgentBar(sd).usage, null);
});

const TSX = join(root, "node_modules", ".bin", "tsx");
const SCRIPT = join(root, "src", "claude-loop", "status-line.ts");
const runLine = (stdin: string, userCommand: string | null, env: Record<string, string> = {}) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (k.startsWith("CL_")) delete base[k];
    return spawnSync(TSX, [SCRIPT, ...(userCommand ? [Buffer.from(userCommand).toString("base64")] : [])], {
        input: stdin, encoding: "utf8", cwd: dir, env: { ...base, ...env }, timeout: 20_000,
    });
};

test("the status line runs the user's with the same stdin; its output and exit code pass through", () => {
    const seen = join(dir, "seen.json");
    const stdin = JSON.stringify({ model: { id: "m" }, rate_limits: RL });
    const r = runLine(stdin, `cat > '${seen}'; printf 'line one'; exit 3`);
    assert.equal(r.stdout, "line one");
    assert.equal(r.status, 3);
    assert.equal(readFileSync(seen, "utf8"), stdin, "the same stdin, whole");
    const none = runLine(stdin, null);
    assert.deepEqual([none.stdout, none.status], ["", 0], "no status line of the user's: nothing shown");
});

test("the status line relays rate_limits to the kernel (buffered here: no kernel listens)", () => {
    const sd = join(dir, "sd-relay");
    mkdirSync(sd);
    const r = runLine(JSON.stringify({ rate_limits: RL }), "printf ok", { CL_STATE_DIR: sd });
    assert.equal(r.stdout, "ok", "relaying does not hold the user's line back");
    const sent = JSON.parse(readFileSync(offloadPath(sd, "hook"), "utf8").trim().split("\n").pop()!) as { event: Record<string, unknown> };
    assert.deepEqual([sent.event.event, sent.event.kind, sent.event.rate_limits], ["hook", "StatusLine", RL]);
});
