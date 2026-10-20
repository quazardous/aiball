// #4122 — a session aiball starts in a folder (a plain shell, a loop, its host) gets
// the folder's Claude config dir when the folder chose one; a client cannot set it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLoginEnvForTests, sessionEnv } from "./env.js";

const root = mkdtempSync(join(tmpdir(), "senv-"));
after(() => { rmSync(root, { recursive: true, force: true }); resetLoginEnvForTests(null); });
resetLoginEnvForTests({ PATH: "/usr/bin:/bin", HOME: "/home/someone" });

function folder(name: string, yaml: string): string {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".aiball.yaml"), yaml);
    return d;
}

test("a folder that chose a Claude config dir: the session has it", () => {
    const d = folder("chose", `consumer:\n  project: chose\nclaude:\n  config_dir: ${join(root, "work-claude")}\n`);
    assert.equal(sessionEnv(undefined, true, d).CLAUDE_CONFIG_DIR, join(root, "work-claude"));
});

test("a folder that chose none keeps the login environment's", () => {
    const d = folder("none", "consumer:\n  project: none\n");
    assert.equal(sessionEnv(undefined, true, d).CLAUDE_CONFIG_DIR, undefined);
    resetLoginEnvForTests({ PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/login/dir" });
    assert.equal(sessionEnv(undefined, true, d).CLAUDE_CONFIG_DIR, "/login/dir");
    resetLoginEnvForTests({ PATH: "/usr/bin:/bin" });
});

test("a client cannot set it: CLAUDE_CONFIG_DIR stays out of the allow-list", () => {
    const d = folder("client", "consumer:\n  project: client\n");
    assert.equal(sessionEnv({ CLAUDE_CONFIG_DIR: "/elsewhere" }, true, d).CLAUDE_CONFIG_DIR, undefined);
});
