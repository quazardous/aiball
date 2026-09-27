/**
 * #3141 — stopping a session leaves nothing running: a program that ignores
 * SIGHUP and SIGTERM (and the children it started) is killed past the grace,
 * its whole process group with it. On a real `cl-session-host`; skipped, and
 * says so, without it. Takes the host's grace (about ten seconds).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const home = mkdtempSync("/tmp/aiball-3141-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const built = ["release", "debug"].map((b) => resolve(import.meta.dirname, "..", "..", "windows", "cl-pty-proxy", "target", b, "cl-session-host")).find(existsSync);
process.env.CL_SESSION_HOST_BIN = process.env.CL_SESSION_HOST_BIN ?? built ?? "";
const skip = existsSync(process.env.CL_SESSION_HOST_BIN) ? false : "no cl-session-host built (cargo build --manifest-path windows/cl-pty-proxy/Cargo.toml)";

const { startSession, stopSession, forgetSessionsForTests } = await import("./registry.js");
after(() => {
    forgetSessionsForTests();
    rmSync(home, { recursive: true, force: true });
});

/** The pids in process group `pgid`, read from /proc. */
function groupMembers(pgid: number): number[] {
    const out: number[] = [];
    for (const name of readdirSafe("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
            // /proc/<pid>/stat: pid (comm) state ppid pgrp …; comm may hold spaces.
            const stat = readFileSync(`/proc/${name}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (Number(fields[2]) === pgid && fields[0] !== "Z") out.push(Number(name));
        } catch { /* gone meanwhile */ }
    }
    return out;
}
function readdirSafe(dir: string): string[] {
    try { return readdirSync(dir); } catch { return []; }
}

test("a program that ignores SIGHUP and SIGTERM, and its child, do not outlive session.stop", { skip, timeout: 40_000 }, async () => {
    // bash stays (a background child), so the group has two members that both ignore the signals.
    const link = await startSession({
        name: "deaf",
        argv: ["bash", "-c", "trap '' HUP TERM INT; sleep 300 & wait"],
        cwd: home,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
        pid = ((await link.call("host.hello")) as { claude: { pid: number | null } }).claude.pid ?? 0;
        if (!pid) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pid > 0, "the command runs");
    await new Promise((r) => setTimeout(r, 300)); // the trap and the child in place
    assert.ok(groupMembers(pid).length >= 2, `the command and its child in group ${pid}`);

    await stopSession(link);
    const left = groupMembers(pid);
    assert.deepEqual(left, [], `nothing of the group left running: ${left.join(", ")}`);
});
