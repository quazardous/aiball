/**
 * #4210 — `session.start` says why `claude-loop start` refused: a start guard's
 * refusal reaches the client as a 422 with its own code and its sentence, not
 * "exited 1 (INTERNAL)". Driven through the real claude-loop: the guard, its
 * exit code and its last line are the contract.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aiball-4210-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.AIBALL_HOME = join(root, "home");
process.env.AIBALL_SOCK = "";
const { loopExitRefusal } = await import("./methods/session.js");
const { ERROR_CODES } = await import("../domain.js");

const BIN = resolve(import.meta.dirname, "..", "..", "bin", "claude-loop");

test("a config dir not through Claude's first run: 422 CONFIG_DIR_NOT_READY, with the dir and the loop's sentence", () => {
    const proj = join(root, "proj");
    const cfg = join(root, "cfg");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".aiball.yaml"), `consumer:\n  project: probe4210\n  agent: probe4210-claude\nclaude:\n  config_dir: ${cfg}\n`);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(CL|AIBALL)_|^CLAUDE/.test(k)) env[k] = v;
    env.AIBALL_HOME = join(root, "home");
    env.AIBALL_SOCK = "";
    const args = ["start", "--no-attach", "--cwd", proj];
    const run = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] });
    const r = loopExitRefusal(run.status ?? -1, run.stderr, args);
    assert.equal(r.status, 422, r.message);
    assert.equal(r.code, ERROR_CODES.CONFIG_DIR_NOT_READY);
    assert.deepEqual(r.details, { config_dir: cfg });
    assert.match(r.message, /has not been through Claude's first run/);
    assert.doesNotMatch(r.message, /aiball-refusal|^claude-loop: /);
});

test("an exit with no guard's line stays internal, with what the loop wrote", () => {
    const r = loopExitRefusal(1, "claude-loop: something broke\n", ["start", "--no-attach"]);
    assert.equal(r.status, 500);
    assert.equal(r.code, ERROR_CODES.INTERNAL);
    assert.equal(r.message, "claude-loop start --no-attach exited 1: something broke");
});

test("a refusal line on another exit code is not taken for a guard's", () => {
    const r = loopExitRefusal(1, "x\naiball-refusal: {\"code\":\"CONFIG_DIR_NOT_READY\",\"details\":{}}\n", ["start", "--no-attach"]);
    assert.equal(r.status, 500);
});
