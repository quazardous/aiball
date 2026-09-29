/**
 * #3235 — stopping a host loop takes its host with it, as stopping a tmux loop
 * takes its tmux session: the kernel's end is `host.shutdown`, the host's
 * directory goes, the daemon forgets the session, and the agent can be started
 * again. A host left without its command (a loop stopped before this fix) is
 * replaced by a new start, not refused with HOST_BUSY. On a real
 * `cl-session-host`; skipped, and says so, without it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testCaller, until } from "../tests/lib.js";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3235-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { startSession, sessionFor, stopSession, forgetSessionsForTests } = await import("./registry.js");
const { hostDirFor } = await import("./hosts.js");
const { hostPort } = await import("../claude-loop/terminal-port.js");
after(async () => {
    // Stop every host this file started: forgetting them would leave them running.
    for (const agent of ["ender", "idle", "busy"]) {
        const link = sessionFor({ agent });
        if (link) await stopSession(link);
    }
    forgetSessionsForTests();
    rmSync(home, { recursive: true, force: true });
});
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" };
const worker = testCaller("worker");

test("the kernel's end shuts the host down: its directory goes and the daemon forgets the session", { skip, timeout: 20_000 }, async () => {
    await startSession({ agent: "ender", argv: ["cat"], cwd: home, env });
    const dir = hostDirFor({ agent: "ender" });
    const term = hostPort({ controlSocket: join(dir, "control.sock"), log: () => {} });
    await term.ready;
    await term.end();
    await until("the host gone", () => sessionFor({ agent: "ender" }) === undefined, 10_000);
    await until("its directory removed", () => !existsSync(dir), 5_000);
});

test("a host left without its command is replaced by a new start, not HOST_BUSY", { skip, timeout: 30_000 }, async () => {
    // `true` exits at once: the host stays, running nothing — what a stop left behind before #3235.
    await startSession({ agent: "idle", argv: ["true"], cwd: home, env });
    await until("the command gone", () => sessionFor({ agent: "idle" })?.running === false, 10_000);
    const r = await getMethod("session.host")!.run(worker, { agent: "idle", argv: ["cat"], cwd: home }) as { running?: boolean };
    assert.equal(r.running, true, "the new start runs");
    assert.equal(sessionFor({ agent: "idle" })?.running, true);
});

test("a host whose command runs is still refused: HOST_BUSY", { skip, timeout: 20_000 }, async () => {
    await startSession({ agent: "busy", argv: ["cat"], cwd: home, env });
    await assert.rejects(
        async () => getMethod("session.host")!.run(worker, { agent: "busy", argv: ["cat"], cwd: home }),
        (e: { code?: string }) => e.code === "HOST_BUSY",
    );
});
