// #4682 — a setting's wizard on the bus: the setting says it has one, the preview runs nothing, a run goes to its end and is kept.
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-4682-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "xdg");
// No loop of this machine is the folder's.
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
// The dir a folder falls back to without its own: one of the test's, never the user's.
process.env.CLAUDE_CONFIG_DIR = join(home, "cfg-default");
const { getMethod } = await import("./methods.js");
await import("./register.js");
after(() => rmSync(home, { recursive: true, force: true }));

const human = testCaller("boss", { kind: "human" });
const call = <T>(name: string, p: Record<string, unknown>, caller = human) => getMethod(name)!.run(caller, p) as T;

const cfgA = join(home, "cfg-a");
const cfgB = join(home, "cfg-b");
const cfgNew = join(home, "cfg-new");
/** A dir that has been through Claude's first run, as a loop's start asks. */
const ready = (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true })); };
ready(cfgA);
ready(cfgB);
ready(join(home, "cfg-default"));
mkdirSync(cfgNew);
const cwd = join(home, "proj");
mkdirSync(cwd);
writeFileSync(join(cwd, ".aiball.yaml"), `consumer:\n  agent: w-4682\nclaude:\n  config_dir: ${cfgA}\n`);

type Run = { run: string; status: string; steps: Array<{ id: string; status: string; said: string | null }>; settings: { config_dir: { value: string } } | null };

test("the setting says it has a wizard", () => {
    const s = call<{ settings: Array<{ key: string; wizard?: { title: string } }> }>("project.settings", { cwd });
    assert.deepEqual(s.settings.find((x) => x.key === "claude.config_dir")?.wizard, { title: "Switch the Claude config dir" });
    assert.equal(s.settings.find((x) => x.key === "claude.remote_control")?.wizard, undefined, "the others are written bare");
});

test("the preview asks and lists, and runs nothing", () => {
    const p = call<{ questions: Array<{ id: string }>; steps: Array<{ id: string }>; loops: unknown[] }>("project.setting_wizard_preview", { cwd, key: "claude.config_dir", value: cfgB });
    assert.deepEqual(p.questions.map((q) => q.id), ["confirm", "fork", "move_sessions"]);
    assert.deepEqual(p.steps.map((s) => s.id), ["free", "ready", "write"], "no loop in this folder");
    assert.deepEqual(p.loops, []);
    assert.match(readFileSync(join(cwd, ".aiball.yaml"), "utf8"), /config_dir: .*cfg-a/, "nothing written");
});

test("refused: a setting without a wizard, the same dir, answers that do not answer, an agent", async () => {
    assert.equal((await refused(() => call("project.setting_wizard_preview", { cwd, key: "claude.remote_control", value: true }))).code, "BAD_REQUEST");
    assert.equal((await refused(() => call("project.setting_wizard_preview", { cwd, key: "claude.config_dir", value: cfgA }))).code, "BAD_REQUEST");
    assert.equal((await refused(() => call("project.setting_wizard_start", { cwd, key: "claude.config_dir", value: cfgB, answers: { confirm: true } }))).code, "BAD_REQUEST");
    assert.equal((await refused(() => call("project.setting_wizard_cancel", { run: "w-none" }))).code, "NOT_FOUND");
    // #4696 — a dir never run: refused as a loop's start would refuse it.
    const notReady = await refused(() => call("project.setting_wizard_preview", { cwd, key: "claude.config_dir", value: cfgNew }));
    assert.deepEqual([notReady.code, (notReady.details as { config_dir: string }).config_dir], ["CONFIG_DIR_NOT_READY", cfgNew]);
});

test("a run goes to its end, writes the dir, and is kept on disk", async () => {
    const run = call<Run>("project.setting_wizard_start", { cwd, key: "claude.config_dir", value: cfgB, answers: { confirm: true, fork: "keep", move_sessions: "yes" } });
    assert.equal(run.status, "running");
    const deadline = Date.now() + 10_000;
    while (run.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(run.status, "done", JSON.stringify(run.steps));
    assert.deepEqual(run.steps.map((s) => `${s.id}:${s.status}`), ["free:done", "ready:done", "write:done"]);
    assert.equal(run.settings?.config_dir.value, cfgB);
    assert.match(readFileSync(join(cwd, ".aiball.yaml"), "utf8"), /config_dir: .*cfg-b/);
    assert.ok(existsSync(join(home, "wizards", `${run.run}.json`)), "kept, for a daemon that restarts");
    assert.equal((await refused(() => call("project.setting_wizard_cancel", { run: run.run }))).code, "CONFLICT", "ended: nothing to cancel");
});

test("#4690 null takes the folder back to the default dir: the key leaves its .aiball.yaml", async () => {
    const run = call<Run>("project.setting_wizard_start", { cwd, key: "claude.config_dir", value: null, answers: { confirm: true, move_sessions: "no" } });
    const deadline = Date.now() + 10_000;
    while (run.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(run.status, "done", JSON.stringify(run.steps));
    assert.equal(run.settings?.config_dir.value, join(home, "cfg-default"));
    assert.doesNotMatch(readFileSync(join(cwd, ".aiball.yaml"), "utf8"), /config_dir/);
});
