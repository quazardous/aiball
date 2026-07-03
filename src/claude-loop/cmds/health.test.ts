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
    checkLoop,
    checkLoopSource,
    checkLoopSock,
    checkProxy,
    checkIpcFreshness,
    checkBootStatus,
    checkSse,
    matchLauncherCmdline,
    checkOrphanLauncher,
    scanOrphanLaunchers,
} = await import("./health.js");

function mkSd(name: string): string {
    const root = process.env.CLAUDE_LOOP_STATE_ROOT!;
    const sd = join(root, name);
    mkdirSync(sd, { recursive: true });
    return sd;
}

test("checkLoop: pid file missing → fail", () => {
    const sd = mkSd("c1");
    const c = checkLoop(sd);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /loop\.pid missing/);
});

test("checkLoop: pid file with non-numeric → fail", () => {
    const sd = mkSd("c1b");
    writeFileSync(join(sd, "loop.pid"), "not-a-number\n");
    const c = checkLoop(sd);
    assert.equal(c.status, "fail");
});

test("checkLoop: live pid but cmdline doesn't match kernel.ts → fail (pid recycled)", () => {
    const sd = mkSd("c2");
    // Our own pid is alive, but the cmdline is node --test, not kernel.ts.
    writeFileSync(join(sd, "loop.pid"), `${process.pid}\n`);
    const c = checkLoop(sd);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /cmdline doesn't match|not running/);
});

test("checkLoopSource: plate.json missing → warn", () => {
    const sd = mkSd("c3");
    const c = checkLoopSource(sd);
    assert.equal(c.status, "warn");
});

test("checkLoopSource: matching SHA → ok", async () => {
    const sd = mkSd("c4");
    const { installRootSha } = await import("../state.js");
    const sha = installRootSha();
    if (sha === null) return; // env doesn't have git, skip.
    const plate = { sd, name: "c4", cwd: "/tmp", started_at: 0, started_at_sha: sha, interval: 60 };
    writeFileSync(join(sd, "plate.json"), JSON.stringify(plate));
    const c = checkLoopSource(sd);
    assert.equal(c.status, "ok");
    assert.match(c.detail, /current/);
});

test("checkLoopSource: stale SHA → warn", () => {
    const sd = mkSd("c5");
    const plate = { sd, name: "c5", cwd: "/tmp", started_at: 0, started_at_sha: "deadbeefcafebabe", interval: 60 };
    writeFileSync(join(sd, "plate.json"), JSON.stringify(plate));
    const c = checkLoopSource(sd);
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

test("checkSse: live=null → fail (no UDS reply)", () => {
    assert.equal(checkSse(null).status, "fail");
});

test("checkSse: sseConnected=null → warn (no connection state yet)", () => {
    const r = checkSse({ sseConnected: null }, 1000);
    assert.equal(r.status, "warn");
});

test("checkSse: sseConnected=false → fail (WakeBus error)", () => {
    const r = checkSse({ sseConnected: false }, 1000);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /disconnected/);
});

test("checkSse: sseConnected=true → ok (connected)", () => {
    const r = checkSse({ sseConnected: true }, 1000);
    assert.equal(r.status, "ok");
    assert.match(r.detail, /connected/);
});

test("checkSse: sseConnected=true + lastSseEventAtMs → age in detail", () => {
    const now = 1_000_000;
    const r = checkSse({ sseConnected: true, lastSseEventAtMs: now - 30_000 }, now);
    assert.equal(r.status, "ok");
    assert.match(r.detail, /last event 30s ago/);
});

test("checkSse: sseConnected=true + quiet 13min → still ok (was false-positive stale)", () => {
    const now = 1_000_000;
    // 793s = david's reported case in #869 (= 13min of silence on live connection)
    const r = checkSse({ sseConnected: true, lastSseEventAtMs: now - 793_000 }, now);
    assert.equal(r.status, "ok");
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

// ---------------------------------------------------------------------------
// #1100 — orphan tmux-launcher detection (Slice 1 de #1090).
// ---------------------------------------------------------------------------

const NUL = "\0";
function cmdline(...argv: string[]): string { return argv.join(NUL) + NUL; }

test("#1100 matchLauncherCmdline: matches the real launcher shape", () => {
    // Forme réelle du start path : new-session -d -s <name> -c <cwd> -- bash -lc <inner>
    const c = cmdline("tmux", "new-session", "-d", "-s", "myloop", "-c", "/home/x/proj", "--", "bash", "-lc", "source '/root/env'; …");
    assert.equal(matchLauncherCmdline(c), "myloop");
});

test("#1100 matchLauncherCmdline: psmux + absolute path tolerated", () => {
    const c = cmdline("/usr/local/bin/psmux", "new-session", "-d", "-s", "w1", "-c", "/p", "--", "bash", "-lc", "x");
    assert.equal(matchLauncherCmdline(c), "w1");
});

test("#1100 matchLauncherCmdline: rejects non-launcher tmux commands", () => {
    assert.equal(matchLauncherCmdline(cmdline("tmux", "attach", "-t", "myloop", "x")), null);
    assert.equal(matchLauncherCmdline(cmdline("tmux", "new-session", "-s", "attached", "-c", "/p")), null); // pas -d
    assert.equal(matchLauncherCmdline(cmdline("vim", "new-session", "-d", "-s", "x", "y")), null);
    assert.equal(matchLauncherCmdline("garbage"), null);
});

const linuxOnly = process.platform === "linux";

test("#1100 checkOrphanLauncher: launcher présent + session MORTE → fail", { skip: !linuxOnly }, () => {
    const c = checkOrphanLauncher("deadloop", {
        scan: () => [{ pid: 4242, session: "deadloop" }],
        alive: () => false,
    });
    assert.equal(c.status, "fail");
    assert.match(c.detail, /orphan tmux launcher \(pid 4242\)/);
});

test("#1100 checkOrphanLauncher: launcher présent + session VIVANTE → ok (pas de faux positif)", { skip: !linuxOnly }, () => {
    const c = checkOrphanLauncher("liveloop", {
        scan: () => [{ pid: 4242, session: "liveloop" }],
        alive: () => true,
    });
    assert.equal(c.status, "ok");
});

test("#1100 checkOrphanLauncher: aucun launcher → ok", { skip: !linuxOnly }, () => {
    const c = checkOrphanLauncher("noloop", { scan: () => [], alive: () => false });
    assert.equal(c.status, "ok");
});

test("#1100 scanOrphanLaunchers: exclut les sessions couvertes + les vivantes", () => {
    const scan = () => [
        { pid: 1, session: "covered" },   // couverte par un rapport per-loop
        { pid: 2, session: "alive" },     // session vivante
        { pid: 3, session: "rmd-loop" },  // le cas state-dir rm'd
    ];
    const out = scanOrphanLaunchers(new Set(["covered"]), { scan, alive: (s) => s === "alive" });
    assert.deepEqual(out, [{ pid: 3, session: "rmd-loop" }]);
});
