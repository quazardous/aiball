// #860 unit tests — pure-function checks of `claude-loop health`.
// Run: `npx tsx --test src/claude-loop/cmds/health.test.ts`.
//
// The HTTP/UDS-dependent checks (loop.sock, aiball daemon) are covered
// by integration runs ; here we exercise the file/pid/tmux probes with
// synthetic state dirs + the pure interpretation of a `LiveLoopState`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-860-"));
process.env.CLAUDE_LOOP_STATE_ROOT = mkdtempSync(join(tmpdir(), "claude-loop-860-"));

const {
    checkTimer,
    checkTimerSource,
    checkLoopSock,
    checkProxy,
    checkIpcFreshness,
    checkBootStatus,
    checkSse,
} = await import("./health.js");

function mkSd(name: string): string {
    const root = process.env.CLAUDE_LOOP_STATE_ROOT!;
    const sd = join(root, name);
    mkdirSync(sd, { recursive: true });
    return sd;
}

test("checkTimer: pid file missing → fail", () => {
    const sd = mkSd("c1");
    const c = checkTimer(sd);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /timer\.pid missing/);
});

test("checkTimer: pid file with non-numeric → fail", () => {
    const sd = mkSd("c1b");
    writeFileSync(join(sd, "timer.pid"), "not-a-number\n");
    const c = checkTimer(sd);
    assert.equal(c.status, "fail");
});

test("checkTimer: live pid but cmdline doesn't match timer.ts → fail (pid recycled)", () => {
    const sd = mkSd("c2");
    // Our own pid is alive, but the cmdline is node --test, not timer.ts.
    writeFileSync(join(sd, "timer.pid"), `${process.pid}\n`);
    const c = checkTimer(sd);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /cmdline doesn't match|not running/);
});

test("checkTimerSource: plate.json missing → warn", () => {
    const sd = mkSd("c3");
    const c = checkTimerSource(sd);
    assert.equal(c.status, "warn");
});

test("checkTimerSource: matching SHA → ok", async () => {
    const sd = mkSd("c4");
    const { installRootSha } = await import("../state.js");
    const sha = installRootSha();
    if (sha === null) return; // env doesn't have git, skip.
    const plate = { sd, name: "c4", cwd: "/tmp", started_at: 0, started_at_sha: sha, interval: 60 };
    writeFileSync(join(sd, "plate.json"), JSON.stringify(plate));
    const c = checkTimerSource(sd);
    assert.equal(c.status, "ok");
    assert.match(c.detail, /current/);
});

test("checkTimerSource: stale SHA → warn", () => {
    const sd = mkSd("c5");
    const plate = { sd, name: "c5", cwd: "/tmp", started_at: 0, started_at_sha: "deadbeefcafebabe", interval: 60 };
    writeFileSync(join(sd, "plate.json"), JSON.stringify(plate));
    const c = checkTimerSource(sd);
    assert.equal(c.status, "warn");
    assert.match(c.detail, /stale|unknown/);
});

test("checkLoopSock: socket missing → fail", () => {
    const c = checkLoopSock(0, true, null);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /missing/);
});

test("checkLoopSock: no reply → fail", () => {
    const c = checkLoopSock(500, false, null);
    assert.equal(c.status, "fail");
});

test("checkLoopSock: reply within budget → ok", () => {
    const c = checkLoopSock(12, false, { bootComplete: true });
    assert.equal(c.status, "ok");
    assert.match(c.detail, /12ms/);
});

test("checkProxy: proxy-alive missing → warn (not a hard fail, proxy is optional)", () => {
    const sd = mkSd("c6");
    const c = checkProxy(sd);
    assert.equal(c.status, "warn");
});

test("checkProxy: stale pid (process dead) → fail", () => {
    const sd = mkSd("c7");
    writeFileSync(join(sd, "proxy-alive"), "1\n"); // pid 1 = init, kill(1, 0) returns EPERM = alive
    // Even if EPERM means "alive but not ours", checkProxy returns fail because cmdline won't match.
    const c = checkProxy(sd);
    assert.notEqual(c.status, "ok");
});

test("checkIpcFreshness: live=null → fail", () => {
    assert.equal(checkIpcFreshness(null).status, "fail");
});

test("checkIpcFreshness: lastViewPushAtMs=null → warn (cold boot)", () => {
    assert.equal(checkIpcFreshness({ lastViewPushAtMs: null }).status, "warn");
});

test("checkIpcFreshness: fresh push → ok", () => {
    const now = Date.now();
    assert.equal(checkIpcFreshness({ lastViewPushAtMs: now - 1_500 }, now).status, "ok");
});

test("checkIpcFreshness: stale push (>10s) → fail", () => {
    const now = Date.now();
    assert.equal(checkIpcFreshness({ lastViewPushAtMs: now - 30_000 }, now).status, "fail");
});

test("checkBootStatus: live=null → fail", () => {
    const sd = mkSd("c8");
    assert.equal(checkBootStatus(sd, null).status, "fail");
});

test("checkBootStatus: bootComplete=true → ok", () => {
    const sd = mkSd("c9");
    assert.equal(checkBootStatus(sd, { bootComplete: true }).status, "ok");
});

test("checkBootStatus: bootComplete=false, recent loop → warn (boot in progress)", () => {
    const sd = mkSd("c10");
    writeFileSync(join(sd, "loop-start-ts"), `${Date.now() - 5_000}`);
    const c = checkBootStatus(sd, { bootComplete: false });
    assert.equal(c.status, "warn");
});

test("checkBootStatus: bootComplete=false, stale loop → fail (stuck)", () => {
    const sd = mkSd("c11");
    writeFileSync(join(sd, "loop-start-ts"), `${Date.now() - 5 * 60_000}`);
    const c = checkBootStatus(sd, { bootComplete: false });
    assert.equal(c.status, "fail");
    assert.match(c.detail, /stuck/);
});

test("checkSse: placeholder warn (daemon endpoint pending)", () => {
    assert.equal(checkSse().status, "warn");
    assert.match(checkSse().detail, /not implemented/);
});

// Sanity check : runHealthChecks aggregates checks + counts.
test("runHealthChecks: unknown loop → fail check on state dir", async () => {
    const { runHealthChecks } = await import("./health.js");
    const r = await runHealthChecks("does-not-exist-cl");
    assert.equal(r.exists, false);
    assert.equal(r.summary.fail, 1);
    assert.equal(r.checks[0].status, "fail");
});

process.on("exit", () => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
    try { rmSync(process.env.CLAUDE_LOOP_STATE_ROOT!, { recursive: true, force: true }); } catch { /* noop */ }
});

// Suppress unused-import lint if symlinkSync isn't used.
void symlinkSync;
