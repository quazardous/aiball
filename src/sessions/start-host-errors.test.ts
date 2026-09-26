/**
 * A session host that cannot start is an error for its caller, never the
 * daemon's end: a spawn failure is an 'error' event on the child, and an
 * unheard one kills the process (a missing cwd did, live).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = mkdtempSync("/tmp/aiball-hosterr-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
// A file that is there but cannot be run: the spawn itself fails (EACCES).
const bin = join(home, "not-executable");
writeFileSync(bin, "");
chmodSync(bin, 0o644);
process.env.CL_SESSION_HOST_BIN = bin;

const { startHost } = await import("./hosts.js");
after(() => rmSync(home, { recursive: true, force: true }));

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

test("a cwd that does not exist is refused before any spawn", async () => {
    await assert.rejects(startHost({ name: "gone", argv: ["cat"], cwd: join(home, "nowhere"), env }), /no such directory/);
});

test("a spawn that fails rejects the start, and the process lives on", async () => {
    await assert.rejects(startHost({ name: "noexec", argv: ["cat"], cwd: home, env }), /could not start/);
});
