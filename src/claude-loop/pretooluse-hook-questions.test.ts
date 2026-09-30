// #3393 — the real hook process reads `claude_loop.questions` at each call, from
// the folder the loop runs in: a change applies without restarting the loop.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "aiball-3393-"));
after(() => rmSync(root, { recursive: true, force: true }));
const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(root, "state");
mkdirSync(stateDir);
mkdirSync(join(root, "xdg", "aiball"), { recursive: true });

/** Run the hook as Claude Code does, in a loop whose folder holds `yaml`; no loop answers: no human present. */
function hook(name: string, yaml: string): { permissionDecision?: string; permissionDecisionReason?: string } {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    const env: NodeJS.ProcessEnv = { ...process.env, CL_STATE_DIR: stateDir, AIBALL_CWD: dir, XDG_CONFIG_HOME: join(root, "xdg") };
    // Started from the repo (where `tsx` resolves); the loop's folder comes by AIBALL_CWD, as in a loop.
    const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "pretooluse-hook.ts")], { cwd: join(here, "../.."), env, input: "{}", encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout.trim() || "{}") as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput ?? {};
}

test("the hook refuses the dialog for the setting it reads in the loop's folder", () => {
    const only = hook("only", "claude_loop:\n  questions: ticket_only\n");
    assert.equal(only.permissionDecision, "deny");
    assert.match(only.permissionDecisionReason ?? "", /ticket_only/);
    const present = hook("present", "claude_loop:\n  questions: present\n");
    assert.equal(present.permissionDecision, "deny", "no human present: today's rule refuses too");
    assert.doesNotMatch(present.permissionDecisionReason ?? "", /ticket_only/);
});
