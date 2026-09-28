/**
 * #3141 — a session's folder under `hosts/`: its plain name while its socket
 * paths fit, a short hashed one when they would not; the daemon and
 * claude-loop find the same folder; and a long name on a deep home starts a
 * real host (skipped, and says so, without one built).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const base = mkdtempSync("/tmp/aiball-3141d-");
// Deep enough that `hosts/term-<a 40-char name>/control.sock` passes 100 bytes.
const home = join(base, "a-rather-deep-aiball-home-for-this-test");
mkdirSync(home, { recursive: true });
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { hostDirName, MAX_SOCKET_PATH } = await import("../session-dir.js");
const { hostDirFor, hostsDir } = await import("./hosts.js");
const { hostAttachSocket } = await import("../claude-loop/host-alive.js");
const { startSession, stopSession, forgetSessionsForTests } = await import("./registry.js");
after(() => {
    forgetSessionsForTests();
    rmSync(base, { recursive: true, force: true });
});

const LONG = "a-session-name-long-enough-to-overflow-it";

test("the plain name while it fits, a short hashed one when a socket path would not", () => {
    assert.equal(hostDirName({ name: "s" }, "/h"), "term-s");
    assert.equal(hostDirName({ agent: "worker" }, "/h"), "worker");
    const long = hostDirName({ name: LONG }, hostsDir());
    assert.match(long, /^term-[0-9a-f]{8}$/);
    assert.ok(join(hostsDir(), long, "control.sock").length <= MAX_SOCKET_PATH);
    assert.match(hostDirName({ agent: LONG }, hostsDir()), /^a-[0-9a-f]{8}$/);
    assert.equal(hostDirName({ name: LONG }, hostsDir()), long, "stable: the same key, the same folder");
});

test("the daemon and claude-loop find the same folder for an agent", () => {
    assert.equal(hostAttachSocket(join(home, "no-loop"), LONG, home), join(hostDirFor({ agent: LONG }), "attach.sock"));
    assert.equal(hostAttachSocket(join(home, "no-loop"), "worker", home), join(hostDirFor({ agent: "worker" }), "attach.sock"));
});

test("a long name on a deep home starts a real host, and stops", { skip, timeout: 30_000 }, async () => {
    const link = await startSession({ name: LONG, argv: ["cat"], cwd: base, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    assert.equal(link.info.name, LONG, "the key, from host.json");
    assert.match(link.info.dir, /term-[0-9a-f]{8}$/);
    await stopSession(link);
});
