/**
 * `aiball project rename-all <old> <new>` (#3759): rename a project, its
 * folder and its `.aiball.yaml` in one run.
 *
 * Three gestures exist on their own: `project rename` (the name, in the
 * daemon), `relocate` (the folder and the state keyed by its path), and the
 * `consumer.project` line of `.aiball.yaml`. Run apart or out of order they
 * leave a project half renamed. This module checks all three before any of
 * them writes, then applies them in that order.
 *
 * The agent keeps its name. When `.aiball.yaml` does not set `consumer.agent`,
 * the agent is derived from the project (`<project>-claude`): renaming the
 * project would make a new agent, without the old one's tickets or tokens. So
 * the old name is written in the file.
 *
 * A step already done is recognised (the project already renamed, the file
 * already patched, the folder already moved), so running the command again
 * after a failure picks up where it stopped.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { patchIdentityStep } from "./project-init.js";
import { applyRelocate, planRelocate, type ApplyResult, type RelocateEnv, type RelocatePlan } from "./relocate.js";

export interface RenameAllInput {
    oldName: string;
    newName: string;
    /** The project folder (the one holding `.aiball.yaml`). */
    from: string;
    /** Where the folder goes; default `<parent>/<new>` when its name is the old project's. */
    dir?: string;
    /** Rename the project and its file, leave the folder where it is. */
    noMove?: boolean;
}

export interface RenameAllDeps {
    /** The project names the daemon knows; throws when it cannot be reached. */
    projectNames: () => Promise<string[]>;
    renameProject: (oldName: string, newName: string) => Promise<unknown>;
    relocateEnv: RelocateEnv;
}

export interface RenameAllPlan {
    old: string;
    new: string;
    /** `rename`, or `done` when the daemon already knows the project by its new name. */
    db: "rename" | "done";
    /** The `.aiball.yaml` edit, or `done` when it already names the new project. */
    yaml: { file: string; project: string; agent: string | null } | "done";
    /** The folder move; null with `--no-move`. */
    relocate: RelocatePlan | null;
    /** Reasons nothing can be applied. Empty = applicable. */
    blockers: string[];
}

export interface RenameAllResult {
    renamed: unknown;
    yaml: { file: string; backup: string } | null;
    relocated: ApplyResult | null;
}

/** `consumer.project` / `consumer.agent` as the file sets them, null when it does not. */
function readIdentity(file: string): { project: string | null; agent: string | null } | { error: string } {
    try {
        const parsed = parseYaml(readFileSync(file, "utf8")) as { consumer?: { project?: unknown; agent?: unknown } } | null;
        const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
        return { project: str(parsed?.consumer?.project), agent: str(parsed?.consumer?.agent) };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/** The agent `.mcp.json` still names (the deprecated place), which wins over the derived one. */
function mcpJsonAgent(dir: string): string | null {
    const p = join(dir, ".mcp.json");
    if (!existsSync(p)) return null;
    try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
        return raw.mcpServers?.aiball?.env?.AIBALL_AGENT ?? null;
    } catch {
        return null;
    }
}

export async function planRenameAll(input: RenameAllInput, deps: RenameAllDeps): Promise<RenameAllPlan> {
    const { oldName, newName } = input;
    const blockers: string[] = [];
    const from = resolve(input.from);
    if (!oldName.trim() || !newName.trim()) blockers.push("the old and new names must not be empty");
    if (oldName === newName) blockers.push("the old and new names are the same");

    // The daemon: the old name known and the new one free, or the rename already done.
    let db: RenameAllPlan["db"] = "rename";
    try {
        const names = new Set(await deps.projectNames());
        if (names.has(oldName) && names.has(newName)) blockers.push(`project "${newName}" already exists — to merge into it, use: aiball project move ${oldName} ${newName}`);
        else if (!names.has(oldName) && names.has(newName)) db = "done";
        else if (!names.has(oldName)) blockers.push(`project "${oldName}" does not exist`);
    } catch (e) {
        blockers.push(`the daemon cannot be reached: ${(e as Error).message}`);
    }

    // The folder: where it goes, or where it already went.
    let target: string | null = null;
    if (!input.noMove) {
        if (input.dir) target = resolve(input.dir);
        else if (basename(from) === oldName) target = join(dirname(from), newName);
        else blockers.push(`the folder is named "${basename(from)}", not "${oldName}" — pass --dir <new-dir>, or --no-move to leave it where it is`);
    }
    let relocate: RelocatePlan | null = null;
    let home = from;
    if (target) {
        const moved = !existsSync(from) && existsSync(target);
        relocate = planRelocate(from, target, deps.relocateEnv, { stateOnly: moved });
        blockers.push(...relocate.blockers);
        if (moved) home = target;
    }

    // `.aiball.yaml`: it names the old project, or none (then the folder's name did).
    let yaml: RenameAllPlan["yaml"] = "done";
    const file = join(home, ".aiball.yaml");
    if (!existsSync(file)) {
        blockers.push(`${file} does not exist — run this from the project folder, or pass --from <dir>`);
    } else {
        const id = readIdentity(file);
        if ("error" in id) {
            blockers.push(`${file} is not valid YAML: ${id.error}`);
        } else if (id.project === newName) {
            yaml = "done";
        } else if (id.project === oldName || (id.project === null && [oldName, newName].includes(basename(home)))) {
            // None set: the folder's name was the project (a folder moved by
            // hand already carries the new one). An agent named nowhere is
            // derived from the project: keep the old one.
            const named = id.agent ?? mcpJsonAgent(home);
            yaml = { file, project: newName, agent: named ? null : `${oldName}-claude` };
        } else {
            blockers.push(`${file} declares project "${id.project ?? basename(home)}", not "${oldName}"`);
        }
    }

    return { old: oldName, new: newName, db, yaml, relocate, blockers };
}

/** Apply a plan with no blockers: the daemon, then the file, then the folder. */
export async function applyRenameAll(plan: RenameAllPlan, deps: Pick<RenameAllDeps, "renameProject">, opts: { fixLinks?: boolean; now?: Date } = {}): Promise<RenameAllResult> {
    if (plan.blockers.length > 0) throw new Error(`cannot rename:\n  - ${plan.blockers.join("\n  - ")}`);
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const result: RenameAllResult = { renamed: null, yaml: null, relocated: null };
    if (plan.db === "rename") result.renamed = await deps.renameProject(plan.old, plan.new);
    if (plan.yaml !== "done") {
        const backup = `${plan.yaml.file}.bak-relocate-${stamp}`;
        copyFileSync(plan.yaml.file, backup);
        patchIdentityStep(plan.yaml.file, { project: plan.yaml.project, ...(plan.yaml.agent ? { agent: plan.yaml.agent } : {}) });
        result.yaml = { file: plan.yaml.file, backup };
    }
    if (plan.relocate) result.relocated = applyRelocate(plan.relocate, { fixLinks: opts.fixLinks, now: opts.now });
    return result;
}
