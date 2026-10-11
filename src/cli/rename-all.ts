/**
 * `aiball project rename-all <old> <new>` (#3759). The rules live in
 * `src/project-rename.ts`; this wires the daemon and the real machine, and
 * prints the plan.
 */
import type { Command } from "commander";
import { resolve } from "node:path";
import { buildClient, die, gOpts, jsonline, userCwd } from "./_helpers.js";
import { fmtApplied, fmtPlan, relocateEnv } from "./relocate.js";

const indent = (text: string): string => text.trimEnd().replace(/^/gm, "  ");

export function registerRenameAllCommand(project: Command): void {
    project
        .command("rename-all <old> <new>")
        .description(
            "Rename a project everywhere at once: its name in aiball, its folder (with the state keyed by the path, as "
            + "`relocate` moves it) and `consumer.project` in its .aiball.yaml. The agent keeps its name. Dry run by default; "
            + "--apply does it. Everything is checked before anything changes; run it again to finish a run that stopped.",
        )
        .option("--from <dir>", "The project folder (default: the current one)")
        .option("--dir <new-dir>", "Where the folder goes (default: <parent>/<new> when the folder is named <old>)")
        .option("--no-move", "Leave the folder where it is")
        .option("--scan <dir>", "Also look under <dir> for symlinks into the old path and files mentioning it (repeatable)",
            (v: string, acc: string[]) => [...acc, v], [] as string[])
        .option("--fix-links", "Repoint the symlinks found into the old path")
        .option("--apply", "Carry the plan out (default: dry run)")
        .option("--json", "Machine-readable JSON output")
        .action(async (oldName: string, newName: string, opts: { from?: string; dir?: string; move: boolean; scan: string[]; fixLinks?: boolean; apply?: boolean; json?: boolean }, cmd: Command) => {
            const { applyRenameAll, planRenameAll } = await import("../project-rename.js");
            const client = buildClient(gOpts(cmd));
            const json = opts.json || gOpts(cmd).json;
            const deps = {
                projectNames: async () => (await client.listProjects()) as string[],
                renameProject: (a: string, b: string) => client.renameProject(a, b),
                relocateEnv: relocateEnv(opts.scan),
            };
            const plan = await planRenameAll({
                oldName,
                newName,
                from: resolve(userCwd(), opts.from ?? "."),
                dir: opts.dir ? resolve(userCwd(), opts.dir) : undefined,
                noMove: !opts.move,
            }, deps);

            if (!opts.apply || plan.blockers.length > 0) {
                if (json) jsonline({ applied: false, plan });
                else {
                    const lines = [`rename project ${plan.old} → ${plan.new}`];
                    lines.push(plan.db === "done" ? "  aiball: already renamed" : `  aiball: rename "${plan.old}" → "${plan.new}" across all tables`);
                    if (plan.yaml === "done") lines.push("  .aiball.yaml: already names the new project");
                    else lines.push(`  ${plan.yaml.file}: consumer.project: ${plan.yaml.project}`
                        + (plan.yaml.agent ? `, consumer.agent: ${plan.yaml.agent} (the agent keeps its name)` : ""));
                    lines.push(plan.relocate ? indent(fmtPlan({ ...plan.relocate, blockers: [] })) : "  folder: left where it is");
                    if (plan.blockers.length > 0) lines.push("cannot rename:", ...plan.blockers.map((b) => `  ✗ ${b}`));
                    else lines.push("dry run — nothing changed; pass --apply to do it");
                    process.stdout.write(lines.join("\n") + "\n");
                }
                if (plan.blockers.length > 0) process.exit(1);
                return;
            }
            try {
                const r = await applyRenameAll(plan, deps, { fixLinks: opts.fixLinks === true });
                if (json) jsonline({ applied: true, plan, result: r });
                else {
                    const lines = [`renamed project ${plan.old} → ${plan.new}`];
                    if (r.renamed) lines.push("  aiball: renamed across all tables");
                    if (r.yaml) lines.push(`  patched ${r.yaml.file} (backup ${r.yaml.backup})`);
                    if (r.relocated && plan.relocate) lines.push(indent(fmtApplied(r.relocated, plan.relocate)));
                    lines.push("left by hand: the remote repository, if its name follows the project; a shell still in the old folder (cd into the new one)");
                    process.stdout.write(lines.join("\n") + "\n");
                }
                if (r.relocated && r.relocated.skipped.length > 0) process.exit(1);
            } catch (e) {
                die(`project rename-all: ${(e as Error).message}\nfix it, then run the same command again: the steps already done are skipped`);
            }
        });
}
