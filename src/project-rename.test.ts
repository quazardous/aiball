// #3759 — `aiball project rename-all`, on a fake machine only: never the real ~/.claude.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyRenameAll, planRenameAll, type RenameAllDeps } from "./project-rename.js";

const ROOTS: string[] = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function machine(yaml: string, opts: { projects?: string[]; processes?: Array<{ pid: number; cwd: string; cmd: string }> } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aiball-3759-")));
    ROOTS.push(root);
    const dir = join(root, "projects", "darktable-helios");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    const names = new Set(opts.projects ?? ["darktable-helios", "aiball"]);
    const calls: string[] = [];
    const deps: RenameAllDeps = {
        projectNames: async () => [...names],
        renameProject: async (a, b) => { calls.push(`${a}→${b}`); names.delete(a); names.add(b); return { ok: true }; },
        relocateEnv: {
            claudeDir: join(root, ".claude"),
            claudeJson: join(root, ".claude.json"),
            loopRoot: join(root, ".claude-loop"),
            scanRoots: [],
            processCwds: () => opts.processes ?? [],
            pidAlive: () => false,
        },
    };
    return { root, dir, newDir: join(root, "projects", "helios"), deps, calls, names };
}

const consumer = (file: string) => (parseYaml(readFileSync(file, "utf8")) as { consumer: Record<string, unknown> }).consumer;

test("the name, the file and the folder, in that order; the agent derived from the project keeps its name", async () => {
    const m = machine("# my notes\nconsumer:\n  project: darktable-helios\n");
    const plan = await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.dir }, m.deps);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.relocate?.new, m.newDir, "the folder goes next to itself, under the new name");
    assert.equal(m.calls.length, 0, "a dry run changes nothing");
    const r = await applyRenameAll(plan, m.deps);
    assert.deepEqual(m.calls, ["darktable-helios→helios"]);
    assert.ok(!existsSync(m.dir) && existsSync(m.newDir));
    const file = join(m.newDir, ".aiball.yaml");
    assert.deepEqual(consumer(file), { project: "helios", agent: "darktable-helios-claude" });
    assert.match(readFileSync(file, "utf8"), /# my notes/, "the file is patched, not rewritten");
    assert.ok(r.yaml && existsSync(r.yaml.backup.replace(m.dir, m.newDir)), "a backup is kept");
});

test("an agent the file names is left alone", async () => {
    const m = machine("consumer:\n  project: darktable-helios\n  agent: dt-helios-claude\n");
    const plan = await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.dir }, m.deps);
    await applyRenameAll(plan, m.deps);
    assert.deepEqual(consumer(join(m.newDir, ".aiball.yaml")), { project: "helios", agent: "dt-helios-claude" });
});

test("anything that would stop a step refuses the whole run before the first one", async () => {
    const running = machine("consumer:\n  project: darktable-helios\n", { processes: [{ pid: 7, cwd: "", cmd: "claude" }] });
    running.deps.relocateEnv.processCwds = () => [{ pid: 7, cwd: running.dir, cmd: "claude" }];
    const cases: Array<[ReturnType<typeof machine>, RegExp]> = [
        [running, /process 7/],
        [machine("consumer:\n  project: darktable-helios\n", { projects: ["darktable-helios", "helios"] }), /already exists.*project move/],
        [machine("consumer:\n  project: darktable-helios\n", { projects: ["aiball"] }), /does not exist/],
        [machine("consumer:\n  project: other\n"), /declares project "other"/],
    ];
    for (const [m, why] of cases) {
        const plan = await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.dir }, m.deps);
        assert.match(plan.blockers.map((b) => b.text).join("\n"), why);
        await assert.rejects(applyRenameAll(plan, m.deps));
        assert.deepEqual(m.calls, [], "nothing renamed");
        assert.ok(existsSync(m.dir), "nothing moved");
        assert.deepEqual(readdirSync(m.dir), [".aiball.yaml"], "nothing patched, no backup");
    }
    const down = machine("consumer:\n  project: darktable-helios\n");
    down.deps.projectNames = async () => { throw new Error("connect ENOENT"); };
    assert.match((await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: down.dir }, down.deps)).blockers.map((b) => b.text).join(), /daemon cannot be reached/);
});

test("a folder not named after the project needs --dir or --no-move", async () => {
    const m = machine("consumer:\n  project: dth\n", { projects: ["dth"] });
    assert.match((await planRenameAll({ oldName: "dth", newName: "helios", from: m.dir }, m.deps)).blockers.map((b) => b.text).join(), /--dir/);
    const plan = await planRenameAll({ oldName: "dth", newName: "helios", from: m.dir, noMove: true }, m.deps);
    assert.deepEqual(plan.blockers, []);
    await applyRenameAll(plan, m.deps);
    assert.ok(existsSync(m.dir), "the folder stays");
    assert.equal(consumer(join(m.dir, ".aiball.yaml")).project, "helios");
});

test("no project in the file: the folder's name was it, and the agent derived from it keeps its name", async () => {
    const m = machine("consumer:\n  no_claim: false\n");
    await applyRenameAll(await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.dir }, m.deps), m.deps);
    assert.deepEqual(consumer(join(m.newDir, ".aiball.yaml")), { no_claim: false, project: "helios", agent: "darktable-helios-claude" });
});

test("a run that stopped is finished by running it again: the steps already done are skipped", async () => {
    const m = machine("consumer:\n  project: darktable-helios\n");
    // Stopped after the rename, with the folder moved by hand.
    await m.deps.renameProject("darktable-helios", "helios");
    renameSync(m.dir, m.newDir);
    m.calls.length = 0;
    const plan = await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.dir }, m.deps);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.db, "done");
    assert.equal(plan.relocate?.mode, "state-only");
    await applyRenameAll(plan, m.deps);
    assert.deepEqual(m.calls, [], "not renamed twice");
    assert.equal(consumer(join(m.newDir, ".aiball.yaml")).project, "helios");
    const again = await planRenameAll({ oldName: "darktable-helios", newName: "helios", from: m.newDir, noMove: true }, m.deps);
    assert.equal(again.yaml, "done");
});
