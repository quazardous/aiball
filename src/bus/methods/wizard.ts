/**
 * #4682 — a folder setting's wizard on the bus: `project.setting_wizard_preview`
 * (the questions, the steps, the loops concerned; nothing runs),
 * `project.setting_wizard_start` (the answers, then aiball runs it) and
 * `project.setting_wizard_cancel` (before its point of no return). A run is
 * followed on `wizard.<run>.state`, its value the whole run, sent whole again
 * at each change; `wizard.*.state` holds the runs under way and those ended in
 * the last hour. A run is kept on disk at each change: one under way when the
 * daemon stops comes back `interrupted`, with what it had done.
 *
 * Who may: as `project.settings_set` — a human, on this machine, locally.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineMethod, getMethod, Refusal, type Caller } from "../methods.js";
import { defineSubject, publish } from "../subscriptions.js";
import { ERROR_CODES } from "../../domain.js";
import { isMachineLocal } from "../../machine-secret.js";
import { AIBALL_HOME } from "../../paths.js";
import { readSettings } from "../../project-settings.js";
import { claudeConfigDir, configDirState, expandConfigDir, sourceDir } from "../../claude-config-dir.js";
import { claudeRunningIn } from "../../claude-config-move.js";
import { getAgentBar } from "../../agent-bar-store.js";
import { answersRefusal, cancellable, newRun, runWizard, type WizardPlan, type WizardRun } from "../../setting-wizard.js";
import { configDirPlan, type ConfigDirOps } from "../../setting-wizard-config-dir.js";
import { folderLoops, loopRunning, stopLoop } from "./loop.js";

/** A run ended this long ago leaves `wizard.*.state`. */
const KEEP_ENDED_MS = 60 * 60_000;
const RUNS_DIR = join(AIBALL_HOME, "wizards");

const runs = new Map<string, WizardRun>();
const cancelAsked = new Set<string>();

function save(run: WizardRun): void {
    try {
        mkdirSync(RUNS_DIR, { recursive: true });
        writeFileSync(join(RUNS_DIR, `${run.run}.json`), JSON.stringify(run));
    } catch (e) {
        console.error(`[wizard] keeping ${run.run} failed:`, e);
    }
}

function changed(run: WizardRun): void {
    save(run);
    publish(`wizard.${run.run}.state`, run);
}

/** Runs ended long enough ago leave memory and disk. */
function prune(now = Date.now()): void {
    for (const [id, r] of runs) {
        if (r.ended_at && now - Date.parse(r.ended_at) > KEEP_ENDED_MS) {
            runs.delete(id);
            try { rmSync(join(RUNS_DIR, `${id}.json`), { force: true }); } catch { /* gone */ }
        }
    }
}

/** At boot: the runs kept on disk; one still `running` was cut by the daemon's stop. */
function loadRuns(): void {
    let files: string[] = [];
    try { files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
    for (const f of files) {
        try {
            const r = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as WizardRun;
            if (r.status === "running") {
                r.status = "interrupted";
                r.ended_at = new Date().toISOString();
                for (const s of r.steps) if (s.status === "running" || s.status === "pending") s.status = "skipped";
                save(r);
            }
            runs.set(r.run, r);
        } catch { /* a file that does not parse is left alone */ }
    }
    prune();
}
loadRuns();

/** #4682 — the machine as the config dir wizard reaches it. */
function configDirOps(caller: Caller): ConfigDirOps {
    return {
        loops: (cwd) => folderLoops(cwd).map((l) => ({ name: l.name, agent: l.agent })),
        busy: (l) => !!l.agent && (getAgentBar(l.agent)?.bar.phase ?? "idle") !== "idle",
        running: (l) => loopRunning(l.name),
        stop: (l) => stopLoop(l.name),
        start: async (l) => { await getMethod("loop.restart")!.run(caller, { name: l.name }); },
        claudeRunning: (cwd) => claudeRunningIn(cwd),
        currentDir: (cwd) => claudeConfigDir(cwd).dir,
        target: (cwd, value) => {
            // #4690 — null: what the folder falls back to, the dir its key's default names.
            const dir = value === null ? claudeConfigDir(null) : sourceDir(expandConfigDir(value, cwd));
            return { dir: dir.dir, firstRunDone: configDirState(dir).first_run_done };
        },
        write: (cwd, value, o) => getMethod("project.settings_set")!.run(caller, {
            cwd, key: "claude.config_dir", value, move_sessions: o.moveSessions, ...(o.fork ? { fork: {} } : {}),
        }) as Record<string, unknown>,
        settings: (cwd) => readSettings(cwd),
    };
}

/** The settings that carry a wizard, and how each makes its plan. */
const WIZARDS: Record<string, (cwd: string, value: unknown, caller: Caller) => WizardPlan> = {
    "claude.config_dir": (cwd, value, caller) => configDirPlan(cwd, value, configDirOps(caller)),
};

function folderOf(caller: Caller, cwd: string): string {
    if (!isMachineLocal(caller)) throw new Refusal(403, "a folder of this machine: local callers only", ERROR_CODES.FORBIDDEN);
    if (!isAbsolute(cwd)) throw new Refusal(400, `cwd must be an absolute path (got '${cwd}')`, ERROR_CODES.BAD_REQUEST);
    return resolve(cwd);
}

function planFor(caller: Caller, cwd: string, key: string, value: unknown): WizardPlan {
    const make = WIZARDS[key];
    if (!make) throw new Refusal(400, `${key} has no wizard (with one: ${Object.keys(WIZARDS).join(", ")})`, ERROR_CODES.BAD_REQUEST);
    try {
        return make(cwd, value, caller);
    } catch (e) {
        if (e instanceof Refusal) throw e;
        throw new Refusal(400, (e as Error).message, ERROR_CODES.BAD_REQUEST);
    }
}

const HUMAN_HERE = {
    who: ["human"] as const,
    machine: true,
    denied: { message: "changing a folder's settings is a human's gesture", code: ERROR_CODES.FORBIDDEN },
};

/** What the wizard of `key` would ask and do for `value` in the folder; nothing runs. */
defineMethod({
    name: "project.setting_wizard_preview",
    ...HUMAN_HERE,
    params: z.object({ cwd: z.string(), key: z.string(), value: z.unknown() }),
    run: (caller, p) => planFor(caller, folderOf(caller, p.cwd), p.key, p.value).preview,
});

/** Start the wizard of `key` with the answers to its questions; answers the run as `wizard.<run>.state` carries it. */
defineMethod({
    name: "project.setting_wizard_start",
    ...HUMAN_HERE,
    params: z.object({ cwd: z.string(), key: z.string(), value: z.unknown(), answers: z.record(z.string(), z.unknown()).default({}) }),
    run: (caller, p) => {
        const cwd = folderOf(caller, p.cwd);
        const holding = [...runs.values()].find((r) => r.status === "running" && r.cwd === cwd);
        if (holding) {
            throw new Refusal(409, `a wizard already runs in ${cwd} (${holding.run}, ${holding.key})`, ERROR_CODES.WIZARD_RUNNING, { run: holding.run });
        }
        const plan = planFor(caller, cwd, p.key, p.value);
        const why = answersRefusal(plan.preview, p.answers);
        if (why) throw new Refusal(400, why, ERROR_CODES.BAD_REQUEST);
        prune();
        const run = newRun(`w-${randomBytes(3).toString("hex")}`, cwd, plan.preview, new Date().toISOString());
        runs.set(run.run, run);
        changed(run);
        void runWizard(run, plan, {
            answers: p.answers,
            changed: () => changed(run),
            cancelRequested: () => cancelAsked.has(run.run),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
        }).finally(() => cancelAsked.delete(run.run));
        return run;
    },
});

/** Cancel a run before its point of no return: the fallback runs, the run ends `cancelled`. */
defineMethod({
    name: "project.setting_wizard_cancel",
    ...HUMAN_HERE,
    params: z.object({ run: z.string() }),
    run: (caller, p) => {
        if (!isMachineLocal(caller)) throw new Refusal(403, "a folder of this machine: local callers only", ERROR_CODES.FORBIDDEN);
        const run = runs.get(p.run);
        if (!run) throw new Refusal(404, `no wizard run ${p.run}`, ERROR_CODES.NOT_FOUND);
        if (run.status !== "running") throw new Refusal(409, `${p.run} has ended (${run.status})`, ERROR_CODES.CONFLICT);
        if (!cancellable(run)) throw new Refusal(409, `${p.run} is past its point of no return`, ERROR_CODES.WIZARD_PAST_RETURN);
        cancelAsked.add(run.run);
        return run;
    },
});

defineSubject({
    pattern: "wizard.*.state",
    machine: true,
    wildcard: true,
    doc: {
        value: "the run, whole, as project.setting_wizard_start answers it, or null; with *, the runs under way and those ended in the last hour, keyed by run",
        event: "the whole run again at each change",
    },
    access: (caller) => caller.kind === "human" && isMachineLocal(caller) ? null : new Refusal(403, "a wizard run is a local human's view"),
    value: (sub) => {
        prune();
        const id = sub.parts[1];
        if (id !== "*") return runs.get(id) ?? null;
        return Object.fromEntries([...runs.values()].map((r) => [r.run, r]));
    },
});

/** For the tests: forget every run. */
export function resetWizardRuns(): void {
    runs.clear();
    cancelAsked.clear();
}
