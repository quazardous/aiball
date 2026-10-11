/**
 * #3765 — `project.rename_all`'s reads and writes of the machine, off the
 * daemon's event loop: they read Claude's history, which can be hundreds of
 * megabytes, and held the daemon 4 s on the live board. The plan and the
 * files' apply run in a child process; the rename in the database stays in
 * the daemon, which owns the connection.
 *
 * A child process, not a worker thread: forked, it inherits the daemon's
 * `execArgv` (tsx, there is no build step), which a worker thread does not
 * take on reliably.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RenameAllInput, RenameAllPlan, RenameAllResult } from "./project-rename.js";

type Job =
    | { op: "plan"; input: RenameAllInput; names: string[] }
    | { op: "apply"; plan: RenameAllPlan };
type Answer = { ok: true; value: unknown } | { ok: false; error: string };

const CHILD_FLAG = "--aiball-rename-worker";

/** Run one job in a child process; its answer, or its error. */
export function inWorker(job: { op: "plan"; input: RenameAllInput; names: string[] }): Promise<RenameAllPlan>;
export function inWorker(job: { op: "apply"; plan: RenameAllPlan }): Promise<RenameAllResult>;
export function inWorker(job: Job): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
        let answered = false;
        child.once("message", (m: Answer) => {
            answered = true;
            if (m.ok) resolve(m.value);
            else reject(new Error(m.error));
            child.disconnect();
        });
        child.once("error", reject);
        child.once("exit", (code) => { if (!answered) reject(new Error(`the rename's child process exited with ${code} before answering`)); });
        child.send(job);
    });
}

async function run(job: Job): Promise<unknown> {
    const { applyRenameAll, planRenameAll } = await import("./project-rename.js");
    if (job.op === "plan") {
        const { relocateEnv } = await import("./relocate-env.js");
        return planRenameAll(job.input, {
            projectNames: async () => job.names,
            renameProject: async () => { throw new Error("the database is renamed in the daemon"); },
            relocateEnv: relocateEnv([]),
        });
    }
    // The database step is done already: only the file and the folder are left.
    return applyRenameAll({ ...job.plan, db: "done" }, { renameProject: async () => null });
}

if (process.argv.includes(CHILD_FLAG) && process.send) {
    process.once("message", (job: Job) => {
        run(job).then(
            (value) => process.send!({ ok: true, value } satisfies Answer),
            (e: unknown) => process.send!({ ok: false, error: (e as Error).message ?? String(e) } satisfies Answer),
        );
    });
}
