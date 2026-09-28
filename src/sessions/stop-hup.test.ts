/**
 * #3158 — stopping a shell session: `session.stop` answers at once, and an
 * interactive shell (which ignores SIGTERM) is gone within the second, ended
 * by the hangup, not after the whole grace. With `wait`, the answer comes once
 * the host is gone, with the exit code. On a real `cl-session-host`; skipped,
 * and says so, without it.
 */
import { test, after } from "node:test";
import { testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3158-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { startSession, sessionFor, forgetSessionsForTests } = await import("./registry.js");
after(() => {
    forgetSessionsForTests();
    rmSync(home, { recursive: true, force: true });
});
const stop = getMethod("session.stop")!;
const boss = testCaller("boss", { kind: "human" });
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" };

test("an interactive shell: the answer at once, and the session gone within the second", { skip, timeout: 20_000 }, async () => {
    await startSession({ name: "sh", argv: ["bash", "--norc", "-i"], cwd: home, env });
    await new Promise((r) => setTimeout(r, 500)); // the shell up, its traps in place
    const t0 = Date.now();
    const r = await stop.run(boss, { name: "sh" } as never) as { stopping?: boolean };
    assert.equal(r.stopping, true);
    assert.ok(Date.now() - t0 < 500, `answered in ${Date.now() - t0} ms`);
    while (sessionFor({ name: "sh" }) && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 50));
    const took = Date.now() - t0;
    assert.equal(sessionFor({ name: "sh" }), undefined, "the session is gone");
    assert.ok(took < 2000, `gone in ${took} ms, not after the ten-second grace`);
});

test("with wait: the answer once the host is gone, with the exit code", { skip, timeout: 20_000 }, async () => {
    await startSession({ name: "waited", argv: ["cat"], cwd: home, env });
    const r = await stop.run(boss, { name: "waited", wait: true } as never) as { exit_code?: number | null; stopping?: boolean };
    assert.equal(r.stopping, undefined);
    assert.ok("exit_code" in r);
    assert.equal(sessionFor({ name: "waited" }), undefined);
});
