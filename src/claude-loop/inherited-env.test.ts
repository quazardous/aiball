// #3175 — a start from inside another loop keeps nothing of it but the way to the daemon, and what was set on purpose.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropInheritedLoopEnv, parentRecord } from "./inherited-env.js";

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
