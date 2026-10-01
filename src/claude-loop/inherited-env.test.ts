// #3175 — a start from inside another loop keeps nothing of it but the way to the daemon, and what was set on purpose.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SESSION_ENV, dropClaudeSessionEnv, dropInheritedLoopEnv, parentRecord, UNSET_CLAUDE_SESSION_SH } from "./inherited-env.js";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "aiball-3175-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The parent loop's record, as its state dir holds it. */
const record: Record<string, string> = {
    CL_NAME: "cl-parent", CL_STATE_DIR: "/sd", CL_CHECK_CMD: "false", CL_AFK_SPEC: "[[1]]",
    AIBALL_AGENT: "parent-claude", AIBALL_PROJECT: "parent", AIBALL_CWD: "/p", AIBALL_PROJECT_CWD: "/p",
    AIBALL_SESSION_KEY: "default", AIBALL_SESSION_MODE: "auto",
};

function parentShell(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        ...record, CL_TMUX: "1", CL_HOST_CONTROL: "/h/parent/control.sock",
        AIBALL_SOCK: "/s", AIBALL_URL: "http://x", AIBALL_TOKEN: "t", AIBALL_HOME: "/h", AIBALL_PORT: "7777", PATH: "/bin", HOME: "/home/u",
        ...extra,
    };
}

test("inside a loop: its CL_* and identity go; the daemon's address, PATH and the rest stay", () => {
    const env = parentShell();
    const r = dropInheritedLoopEnv(env, () => record);
    assert.equal(r?.from, "/sd");
    assert.deepEqual(Object.keys(env).sort(), ["AIBALL_HOME", "AIBALL_PORT", "AIBALL_SOCK", "AIBALL_TOKEN", "AIBALL_URL", "HOME", "PATH"]);
});

test("a variable set on purpose stays: one the parent never set, or set to another value", () => {
    const env = parentShell({ CL_CLAUDE_CMD: "fake-claude", CL_CHECK_CMD: "true", AIBALL_AGENT: "chosen" });
    dropInheritedLoopEnv(env, () => record);
    assert.equal(env.CL_CLAUDE_CMD, "fake-claude", "the parent never set it");
    assert.equal(env.CL_CHECK_CMD, "true", "the parent ran with false");
    assert.equal(env.AIBALL_AGENT, "chosen");
    assert.equal(env.CL_HOST_CONTROL, undefined, "a host's control socket is always the parent's");
    assert.equal(env.CL_STATE_DIR, undefined);
});

test("no record of the parent to read: everything of the loop's goes", () => {
    const env = parentShell({ CL_CLAUDE_CMD: "fake-claude" });
    dropInheritedLoopEnv(env, () => null);
    assert.equal(env.CL_CLAUDE_CMD, undefined);
    assert.equal(env.AIBALL_SOCK, "/s");
});

test("outside a loop: nothing changes, a CL_* prefix on the command is an override someone meant", () => {
    const env: NodeJS.ProcessEnv = { CL_CHECK_CMD: "true", AIBALL_AGENT: "me", PATH: "/bin" };
    assert.equal(dropInheritedLoopEnv(env, () => record), null);
    assert.deepEqual(env, { CL_CHECK_CMD: "true", AIBALL_AGENT: "me", PATH: "/bin" });
});

test("the record: env, then env.local over it, quotes undone", () => {
    writeFileSync(join(dir, "env"), "# header\nexport CL_CHECK_CMD='aiball pings-count -q'\nexport AIBALL_AGENT='it'\\''s'\n");
    writeFileSync(join(dir, "env.local"), "export CL_CHECK_CMD='true'\n");
    assert.deepEqual(parentRecord(dir), { CL_CHECK_CMD: "true", AIBALL_AGENT: "it's" });
    assert.equal(parentRecord(join(dir, "none")), null);
});

// #3460 — a loop started from a Claude Code session's shell is not that session's child.
const SESSION_MARKERS = {
    CLAUDECODE: "1", CLAUDE_PID: "42", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_EXECPATH: "/x", CLAUDE_CODE_BRIDGE_SESSION_ID: "b",
    CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_MESSAGING_TOKEN: "t",
};
const MEANT = { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_DISABLE_MOUSE: "1", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_EFFORT: "high", PATH: "/bin" };

test("#3460 a Claude Code session's markers are dropped; settings meant for every Claude stay", () => {
    const env: NodeJS.ProcessEnv = { ...SESSION_MARKERS, ...MEANT };
    assert.deepEqual(dropClaudeSessionEnv(env).sort(), Object.keys(SESSION_MARKERS).sort());
    assert.deepEqual(env, MEANT);
});

test("#3460 the env file's line clears the same markers in bash, whatever the tmux server handed down", { skip: process.platform === "win32" && "bash path differs" }, () => {
    const r = spawnSync("bash", ["-c", `${UNSET_CLAUDE_SESSION_SH}; env`], { env: { ...SESSION_MARKERS, ...MEANT }, encoding: "utf8" });
    const names = r.stdout.split("\n").map((l) => l.split("=")[0]!).filter((n) => /^CLAUDE/.test(n)).sort();
    assert.deepEqual(names, Object.keys(MEANT).filter((k) => /^CLAUDE/.test(k)).sort());
    assert.ok(names.every((n) => !CLAUDE_SESSION_ENV.test(n)));
});
