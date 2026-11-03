/**
 * #4682 — the wizard of `claude.config_dir`: moving a folder's loops to another
 * Claude Code config dir without cutting a turn, without a Claude writing its
 * sessions under the move, and with the loops back on their conversation.
 *
 * Steps: wait until the folder's loops are idle, stop them, wait until no
 * Claude runs in the folder, write the dir (moving the conversations, forking
 * the dir: the point of no return), start the loops again. Before the write,
 * a stop or a failure starts again the loops already stopped, on the current
 * dir. The machine is reached through `ConfigDirOps`, so the tests drive it.
 */
import { StepFailed, type WizardPlan, type WizardQuestion, type WizardStepView } from "./setting-wizard.js";

export const IDLE_WAIT_MS = 5 * 60_000;
export const STOP_WAIT_MS = 60_000;
export const FREE_WAIT_MS = 30_000;

export interface FolderLoop {
    name: string;
    agent: string | null;
}

export interface ConfigDirOps {
    /** The folder's running loops. */
    loops(cwd: string): FolderLoop[];
    /** Claude works in this loop (not idle). */
    busy(loop: FolderLoop): boolean;
    running(loop: FolderLoop): boolean;
    stop(loop: FolderLoop): Promise<void>;
    /** Start a stopped loop again, on its conversation. */
    start(loop: FolderLoop): Promise<void>;
    /** The Claude processes in the folder, or null when they cannot be listed here. */
    claudeRunning(cwd: string): Array<{ pid: number; cmd: string }> | null;
    /** The dir the folder's loops start Claude with now. */
    currentDir(cwd: string): string;
    /** Where `value` points, and whether that dir has been through Claude's first run. */
    target(cwd: string, value: string): { dir: string; firstRunDone: boolean };
    /** Write the setting: `project.settings_set` with the answers; what it did. */
    write(cwd: string, value: string, opts: { moveSessions: boolean; fork: boolean }): Record<string, unknown>;
    settings(cwd: string): unknown;
}

export const CONFIG_DIR_TITLE = "Switch the Claude config dir";

function names(loops: FolderLoop[]): string {
    return loops.map((l) => l.agent ?? l.name).join(", ");
}

/** The plan for `value`; refuses (`Error` with a message for the client) what cannot be switched to. */
export function configDirPlan(cwd: string, value: unknown, ops: ConfigDirOps): WizardPlan {
    if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error("claude.config_dir takes a directory path");
    const current = ops.currentDir(cwd);
    const target = ops.target(cwd, value);
    if (target.dir === current) throw new Error(`the folder's loops already start Claude with ${current}`);
    const loops = ops.loops(cwd);
    const n = loops.length;

    const loopNames = loops.map((l) => l.name);
    const questions: WizardQuestion[] = [{
        id: "confirm", kind: "confirm",
        facts: { current, target: target.dir, loops: loopNames },
        label: n === 0
            ? `Start this folder's loops on ${target.dir} from now on; none runs now`
            : `Stop and restart ${n} loop${n > 1 ? "s" : ""} (${names(loops)}) on ${target.dir}; ${n > 1 ? "their conversations follow" : "its conversation follows"}`,
    }];
    if (!target.firstRunDone) {
        questions.push({
            id: "fork", kind: "choose", default: "fork",
            facts: { current, target: target.dir, target_first_run: false },
            label: `${target.dir} has not been through Claude's first run: start it from ${current}?`,
            options: [
                { key: "fork", label: `Link the account and settings of ${current}` },
                { key: "empty", label: "Leave it empty: Claude's first run is yours to do there" },
            ],
        });
    }
    questions.push({
        id: "move_sessions", kind: "choose", default: "yes",
        facts: { from: current, to: target.dir },
        label: `Move this folder's conversations from ${current} to ${target.dir}?`,
        options: [
            { key: "yes", label: "Move them: the loops resume where they were" },
            { key: "no", label: "Leave them: the loops start fresh conversations" },
        ],
    });

    const steps: WizardStepView[] = [
        ...(n > 0 ? [
            { id: "idle", label: "Wait until the folder's loops are idle" },
            { id: "stop", label: "Stop the folder's loops" },
        ] : []),
        { id: "free", label: "Wait until no Claude runs in the folder" },
        { id: "write", label: "Write the dir, move the conversations", point_of_no_return: true },
        ...(n > 0 ? [{ id: "start", label: "Start the loops again" }] : []),
    ];

    let stopped: FolderLoop[] = [];
    return {
        preview: {
            key: "claude.config_dir", value, title: CONFIG_DIR_TITLE,
            loops: loops.map((l) => ({ name: l.name, agent: l.agent, busy: ops.busy(l) })),
            questions, steps,
            fallback: n > 0 ? `Before the write, the loops start again on ${current}` : `Before the write, nothing has changed`,
            fallback_code: n > 0 ? "restart_on_current" : "nothing_changed",
            fallback_facts: { current, loops: loopNames },
        },
        steps: {
            idle: async (ctx) => {
                const busy = () => loops.filter((l) => ops.running(l) && ops.busy(l));
                await ctx.waitUntil(
                    () => busy().length === 0, IDLE_WAIT_MS,
                    () => ({ said: `Waiting for ${names(busy())} (busy)`, code: "waiting_busy", details: { busy: busy().map((l) => l.name) } }),
                    () => ({ said: `Still busy after ${IDLE_WAIT_MS / 60_000} min: ${names(busy())}; nothing changed`, code: "still_busy", details: { busy: busy().map((l) => l.name), waited_s: IDLE_WAIT_MS / 1000 } }),
                );
                return { said: "The folder's loops are idle", code: "loops_idle" };
            },
            stop: async (ctx) => {
                for (const l of loops) {
                    if (!ops.running(l)) continue;
                    ctx.say({ said: `Stopping ${l.agent ?? l.name}`, code: "stopping", details: { loop: l.name } });
                    await ops.stop(l);
                    stopped.push(l);
                }
                await ctx.waitUntil(
                    () => loops.every((l) => !ops.running(l)), STOP_WAIT_MS,
                    () => ({ said: `Waiting for ${names(loops.filter((l) => ops.running(l)))} to stop`, code: "waiting_stop", details: { running: loops.filter((l) => ops.running(l)).map((l) => l.name) } }),
                    () => ({ said: `Still running after ${STOP_WAIT_MS / 1000} s: ${names(loops.filter((l) => ops.running(l)))}`, code: "still_running", details: { running: loops.filter((l) => ops.running(l)).map((l) => l.name), waited_s: STOP_WAIT_MS / 1000 } }),
                );
                return { said: `Stopped ${names(stopped) || "nothing"}`, code: "stopped", details: { stopped: stopped.map((l) => l.name) } };
            },
            free: async (ctx) => {
                if (ops.claudeRunning(cwd) === null) return { said: "Claude's processes cannot be listed here: not checked", code: "not_checked" };
                await ctx.waitUntil(
                    () => (ops.claudeRunning(cwd) ?? []).length === 0, FREE_WAIT_MS,
                    () => {
                        const pids = ops.claudeRunning(cwd) ?? [];
                        return { said: `Waiting for ${pids.length} Claude process${pids.length > 1 ? "es" : ""} to end`, code: "claude_in_folder", details: { pids } };
                    },
                    () => {
                        const pids = ops.claudeRunning(cwd) ?? [];
                        return { said: `A Claude still runs in the folder after ${FREE_WAIT_MS / 1000} s (${pids.map((p) => p.pid).join(", ")}); nothing changed`, code: "claude_still_in_folder", details: { pids, waited_s: FREE_WAIT_MS / 1000 } };
                    },
                );
                return { said: "No Claude runs in the folder", code: "folder_free" };
            },
            write: async (ctx) => {
                const moveSessions = ctx.answers.move_sessions !== "no";
                const fork = ctx.answers.fork === "fork";
                const details = ops.write(cwd, value, { moveSessions, fork });
                return { said: `The folder's loops now start Claude with ${target.dir}`, code: "written", details: { dir: target.dir, ...details } };
            },
            start: async (ctx) => {
                const failed: Array<{ name: string; error: string }> = [];
                for (const l of loops) {
                    ctx.say({ said: `Starting ${l.agent ?? l.name}`, code: "starting", details: { loop: l.name } });
                    try { await ops.start(l); } catch (e) { failed.push({ name: l.name, error: (e as Error).message ?? String(e) }); }
                }
                if (failed.length > 0) {
                    throw new StepFailed({ said: `Not started again: ${failed.map((f) => f.name).join(", ")}; the dir is written`, code: "not_started", details: { failed } });
                }
                return { said: `Started ${names(loops)} again`, code: "started", details: { started: loopNames } };
            },
        },
        fallback: async () => {
            if (stopped.length === 0) return null;
            const failed: string[] = [];
            for (const l of stopped) {
                try { await ops.start(l); } catch { failed.push(l.name); }
            }
            const back = stopped.filter((l) => !failed.includes(l.name));
            stopped = [];
            return {
                ran: true,
                said: failed.length === 0
                    ? `Started ${names(back)} again on ${current}`
                    : `Started ${names(back) || "none"} again on ${current}; not started: ${failed.join(", ")}`,
                code: failed.length === 0 ? "restarted_on_current" : "not_restarted",
                details: { dir: current, restarted: back.map((l) => l.name), failed },
            };
        },
        settings: () => ops.settings(cwd),
    };
}
