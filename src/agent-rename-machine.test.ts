// #3760 — the machine's side of renaming an agent, on a fake machine only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentMachine, planAgentMachine, type AgentMachineEnv } from "./agent-rename-machine.js";

const ROOTS: string[] = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function machine(opts: { loopPid?: number; hostPid?: number; newHost?: boolean } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aiball-3760m-")));
    ROOTS.push(root);
    const project = join(root, "projects", "helios");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".aiball.yaml"), "# notes\nconsumer:\n  project: helios\n  agent: dt-helios-claude\n");
    const loopRoot = join(root, ".claude-loop");
    const loop = join(loopRoot, "cl-helios-1");
    mkdirSync(loop, { recursive: true });
    const hosts = join(root, "hosts");
    writeFileSync(join(loop, "plate.json"), JSON.stringify({ name: "cl-helios-1", cwd: project, consumer: "dt-helios-claude", agent: "dt-helios-claude", host_agent: "dt-helios-claude", host_dir: join(hosts, "dt-helios-claude") }));
    writeFileSync(join(loop, "env"), "export AIBALL_PROJECT='helios'\nexport AIBALL_AGENT='dt-helios-claude'\nexport CL_NAME='cl-helios-1'\n");
    writeFileSync(join(loop, "loop.pid"), String(opts.loopPid ?? 1));
    mkdirSync(join(hosts, "dt-helios-claude"), { recursive: true });
    writeFileSync(join(hosts, "dt-helios-claude", "host.json"), JSON.stringify({ agent: "dt-helios-claude", pid: opts.hostPid ?? 2 }));
    if (opts.newHost) mkdirSync(join(hosts, "helios-claude"), { recursive: true });
    const alive = new Set([opts.loopPid, opts.hostPid].filter((p): p is number => p !== undefined));
    const env: AgentMachineEnv = { loopRoot, hostDirFor: (a) => join(hosts, a), pidAlive: (p) => alive.has(p) };
    return { root, project, loop, hosts, env };
}

test("the plate, the env, the host's folder and the folder's .aiball.yaml follow the new name, each with a backup", () => {
    const m = machine();
    const plan = planAgentMachine("dt-helios-claude", "helios-claude", m.env);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual([plan.loops.map((l) => l.name), plan.yamls, plan.host?.to], [["cl-helios-1"], [join(m.project, ".aiball.yaml")], join(m.hosts, "helios-claude")]);
    const r = applyAgentMachine("dt-helios-claude", "helios-claude", plan);
    const plate = JSON.parse(readFileSync(join(m.loop, "plate.json"), "utf8"));
    assert.deepEqual([plate.consumer, plate.agent, plate.host_agent, plate.host_dir], ["helios-claude", "helios-claude", "helios-claude", join(m.hosts, "helios-claude")]);
    assert.match(readFileSync(join(m.loop, "env"), "utf8"), /^export AIBALL_AGENT='helios-claude'$/m);
    assert.match(readFileSync(join(m.project, ".aiball.yaml"), "utf8"), /# notes[\s\S]*agent: helios-claude/, "patched, comments kept");
    assert.ok(existsSync(join(m.hosts, "helios-claude", "host.json")) && !existsSync(join(m.hosts, "dt-helios-claude")));
    assert.equal(r.rewritten.length, 3);
    for (const w of r.rewritten) assert.ok(existsSync(w.backup), w.backup);
});

test("refused while its loop or its host runs; nothing changed", () => {
    for (const opts of [{ loopPid: 4242 }, { hostPid: 4343 }]) {
        const m = machine(opts);
        const plan = planAgentMachine("dt-helios-claude", "helios-claude", m.env);
        assert.equal(plan.blockers.length, 1, JSON.stringify(opts));
        assert.throws(() => applyAgentMachine("dt-helios-claude", "helios-claude", plan));
        assert.match(readFileSync(join(m.loop, "env"), "utf8"), /AIBALL_AGENT='dt-helios-claude'/);
    }
});

test("the new name's host folder exists already (renamed by hand): the old one is left, and said so", () => {
    const m = machine({ newHost: true });
    const plan = planAgentMachine("dt-helios-claude", "helios-claude", m.env);
    assert.equal(plan.host, null);
    assert.equal(plan.notes.length, 1);
    applyAgentMachine("dt-helios-claude", "helios-claude", plan);
    assert.ok(existsSync(join(m.hosts, "dt-helios-claude")));
    assert.equal(JSON.parse(readFileSync(join(m.loop, "plate.json"), "utf8")).agent, "helios-claude");
});
