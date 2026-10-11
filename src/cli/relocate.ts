/**
 * `aiball relocate <old> <new>` (#2468). The rules live in `src/relocate.ts`;
 * this wires the real machine (home, /proc, pids) and prints the plan.
 */
import type { Command } from "commander";
import { die, gOpts, jsonline } from "./_helpers.js";
import { blockerTexts, type ApplyResult, type RelocatePlan } from "../relocate.js";
import { relocateEnv } from "../relocate-env.js";

export function fmtPlan(p: RelocatePlan): string {
    const lines = [`relocate ${p.old} → ${p.new} (${p.mode})`];
    if (p.mode === "move") lines.push(`  folder: rename`);
    for (const d of p.transcriptDirs) lines.push(`  claude history dir: ${d.from} → ${d.to}`);
    for (const r of p.rewrites) lines.push(`  rewrite ${r.kind}: ${r.file} (${r.count} path${r.count > 1 ? "s" : ""})`);
    for (const l of p.loops) lines.push(`  loop ${l.name}: ${l.alive ? "RUNNING" : "stopped, its plate is rewritten"}`);
    for (const l of p.links) lines.push(`  symlink into the old path: ${l.link} → ${l.target}`);
    for (const r of p.references) lines.push(`  mentions the old path (not rewritten): ${r}`);
    if (p.processCheckUnavailable) lines.push(`  ! running processes cannot be listed on this platform — make sure nothing runs in ${p.old}`);
    if (p.blockers.length > 0) {
        lines.push(`cannot relocate:`);
        for (const b of blockerTexts(p.blockers)) lines.push(`  ✗ ${b}`);
    }
    return lines.join("\n") + "\n";
}

export function fmtApplied(r: ApplyResult, p: RelocatePlan): string {
    const lines = [`relocated ${p.old} → ${p.new}`];
    for (const d of r.renamed) lines.push(`  moved ${d.from} → ${d.to}`);
    for (const w of r.rewritten) lines.push(`  rewrote ${w.count} in ${w.file} (backup ${w.backup})`);
    for (const s of r.skipped) lines.push(`  ! skipped ${s.file}: ${s.reason}`);
    for (const l of r.relinked) lines.push(`  relinked ${l.link} → ${l.target}`);
    if (p.links.length > 0 && r.relinked.length === 0) lines.push(`  ! ${p.links.length} symlink(s) still point at the old path (--fix-links repoints them)`);
    if (p.references.length > 0) lines.push(`  ! ${p.references.length} file(s) still mention the old path — see the dry run`);
    return lines.join("\n") + "\n";
}

export function registerRelocateCommands(program: Command): void {
    program
        .command("relocate <old> <new>")
        .description(
            "Move a project folder AND the state keyed by its path: Claude Code's history (transcripts, prompt history, "
            + "trust and per-project settings) and claude-loop registrations. Dry run by default — prints the plan, changes "
            + "nothing; --apply does it. Refuses while a loop or any process runs in the old folder. Every rewritten file keeps "
            + "a .bak-relocate-<date> copy.",
        )
        .option("--apply", "Carry the plan out (default: dry run)")
        .option("--state-only", "The folder was already moved: only catch the state up")
        .option("--scan <dir>", "Also look under <dir> for symlinks into the old path and files mentioning it (repeatable)",
            (v: string, acc: string[]) => [...acc, v], [] as string[])
        .option("--fix-links", "Repoint the symlinks found into the old path")
        .option("--json", "Machine-readable JSON output")
        .action(async (oldArg: string, newArg: string, opts: { apply?: boolean; stateOnly?: boolean; scan: string[]; fixLinks?: boolean; json?: boolean }, cmd: Command) => {
            const { applyRelocate, planRelocate } = await import("../relocate.js");
            const env = relocateEnv(opts.scan);
            const json = opts.json || gOpts(cmd).json;
            const plan = planRelocate(oldArg, newArg, env, { stateOnly: opts.stateOnly === true });
            if (!opts.apply || plan.blockers.length > 0) {
                if (json) jsonline({ applied: false, plan });
                else process.stdout.write(fmtPlan(plan) + (plan.blockers.length === 0 ? "dry run — nothing changed; pass --apply to do it\n" : ""));
                if (plan.blockers.length > 0) process.exit(1);
                return;
            }
            try {
                const r = applyRelocate(plan, { fixLinks: opts.fixLinks === true });
                if (json) jsonline({ applied: true, plan, result: r });
                else process.stdout.write(fmtApplied(r, plan));
                if (r.skipped.length > 0) process.exit(1);
            } catch (e) {
                die(`relocate: ${(e as Error).message}`);
            }
        });
}
