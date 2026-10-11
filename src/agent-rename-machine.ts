/**
 * #3760 — the machine's side of renaming an agent, what the daemon cannot see:
 * the plates and env of its loops (`~/.claude-loop/<loop>/`), its session
 * host's folder (`hosts/<agent>`), and `consumer.agent` in the `.aiball.yaml`
 * of each loop's folder. Planned first (a dry run changes nothing), refused
 * while one of its loops or its host still runs, then applied. Every file
 * rewritten keeps a `.bak-rename-<date>` copy.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { patchIdentityStep } from "./project-init.js";
import { AIBALL_HOME } from "./paths.js";
import { hostDirName } from "./session-dir.js";

export interface AgentMachineEnv {
    /** claude-loop state root (`~/.claude-loop`). */
    loopRoot: string;
    /** The session host folder of an agent (`hosts/<agent>`, hashed when long). */
    hostDirFor: (agent: string) => string;
    pidAlive: (pid: number) => boolean;
}

export interface AgentMachinePlan {
    /** Loops of the agent: their state folder and their working folder. */
    loops: Array<{ name: string; dir: string; cwd: string | null }>;
    /** `.aiball.yaml` files whose `consumer.agent` names the old agent. */
    yamls: string[];
    /** The host folder to move, null when there is none (or the new one exists). */
    host: { from: string; to: string } | null;
    /** Why nothing can be applied. Empty = applicable. */
    blockers: string[];
    /** What is left alone, and why. */
    notes: string[];
}

/** The real machine: the loops' state root, the session hosts' folders, live pids. */
export function agentMachineEnv(): AgentMachineEnv {
    return {
        loopRoot: process.env.CLAUDE_LOOP_STATE_ROOT ?? join(homedir(), ".claude-loop"),
        // The folder the session host of an agent lives in (sessions/hosts.ts names it the same way).
        hostDirFor: (agent) => join(AIBALL_HOME, "hosts", hostDirName({ agent }, join(AIBALL_HOME, "hosts"))),
        pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    };
}

const PLATE_AGENT_FIELDS = ["agent", "consumer", "host_agent"] as const;

function readJson(file: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function pidIn(file: string): number | null {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8").trim();
    const n = Number(raw.startsWith("{") ? (JSON.parse(raw) as { pid?: unknown }).pid : raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function planAgentMachine(oldId: string, newId: string, env: AgentMachineEnv): AgentMachinePlan {
    const plan: AgentMachinePlan = { loops: [], yamls: [], host: null, blockers: [], notes: [] };
    if (existsSync(env.loopRoot)) {
        for (const name of readdirSync(env.loopRoot)) {
            const dir = join(env.loopRoot, name);
            const plate = readJson(join(dir, "plate.json"));
            if (!plate || !PLATE_AGENT_FIELDS.some((f) => plate[f] === oldId)) continue;
            const cwd = typeof plate.cwd === "string" ? plate.cwd : null;
            plan.loops.push({ name, dir, cwd });
            const pid = pidIn(join(dir, "loop.pid"));
            if (pid !== null && env.pidAlive(pid)) plan.blockers.push(`loop ${name} of ${oldId} is running — stop it first`);
            if (cwd) {
                const yaml = join(cwd, ".aiball.yaml");
                try {
                    const agent = (parseYaml(readFileSync(yaml, "utf8")) as { consumer?: { agent?: unknown } } | null)?.consumer?.agent;
                    if (agent === oldId && !plan.yamls.includes(yaml)) plan.yamls.push(yaml);
                } catch { /* no file, or not ours to read: nothing names the agent there */ }
            }
        }
    }
    const from = env.hostDirFor(oldId);
    if (existsSync(from)) {
        const pid = pidIn(join(from, "host.json"));
        if (pid !== null && env.pidAlive(pid)) plan.blockers.push(`the session host of ${oldId} is running (pid ${pid}) — stop it first`);
        const to = env.hostDirFor(newId);
        if (existsSync(to)) plan.notes.push(`${to} exists already: ${from} is left as it is`);
        else plan.host = { from, to };
    }
    return plan;
}

export interface AgentMachineResult {
    rewritten: Array<{ file: string; backup: string }>;
    movedHost: { from: string; to: string } | null;
}

function backupOf(file: string, stamp: string): string {
    const backup = `${file}.bak-rename-${stamp}`;
    copyFileSync(file, backup);
    return backup;
}

export function applyAgentMachine(oldId: string, newId: string, plan: AgentMachinePlan, opts: { now?: Date } = {}): AgentMachineResult {
    if (plan.blockers.length > 0) throw new Error(`cannot rename:\n  - ${plan.blockers.join("\n  - ")}`);
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const out: AgentMachineResult = { rewritten: [], movedHost: null };
    if (plan.host) {
        renameSync(plan.host.from, plan.host.to);
        out.movedHost = plan.host;
    }
    for (const loop of plan.loops) {
        const plateFile = join(loop.dir, "plate.json");
        const plate = readJson(plateFile);
        if (plate) {
            const backup = backupOf(plateFile, stamp);
            for (const f of PLATE_AGENT_FIELDS) if (plate[f] === oldId) plate[f] = newId;
            if (plan.host && plate.host_dir === plan.host.from) plate.host_dir = plan.host.to;
            writeFileSync(plateFile, JSON.stringify(plate, null, 2) + "\n");
            out.rewritten.push({ file: plateFile, backup });
        }
        const envFile = join(loop.dir, "env");
        if (existsSync(envFile)) {
            const text = readFileSync(envFile, "utf8");
            const next = text.replace(/^(export AIBALL_AGENT=)(['"]?)([^'"\n]*)\2$/m, (m, head: string, q: string, value: string) => (value === oldId ? `${head}${q}${newId}${q}` : m));
            if (next !== text) {
                const backup = backupOf(envFile, stamp);
                writeFileSync(envFile, next);
                out.rewritten.push({ file: envFile, backup });
            }
        }
    }
    for (const yaml of plan.yamls) {
        const backup = backupOf(yaml, stamp);
        patchIdentityStep(yaml, { agent: newId });
        out.rewritten.push({ file: yaml, backup });
    }
    return out;
}
