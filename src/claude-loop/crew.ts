/**
 * #1435 slice 2 — crew lifecycle. A crew agent is an assignment-only worker
 * (role=crew, see slice 1) that runs in its OWN git worktree so several agents
 * can work the same repo without stepping on each other at time T.
 *
 * `claude-loop crew create <name>` provisions a worktree at
 * `<project-root>/worktrees/<name>` (branch `crew/<name>`), derives the crew
 * identity, and with `--start` launches a loop there in `--role crew`.
 * `claude-loop crew list` shows the provisioned crews.
 *
 * Design (david): the worktree exists for ONE reason — isolation at time T.
 * Refresh is best-effort; a branch that has diverged is NOT force-resolved
 * here ("a conflict is normal project life", out of scope). The pure planning
 * layer (`crewProvisionPlan` + helpers) is unit-tested; the git + spawn calls
 * are thin wrappers, guarded behind `--dry-run` for a side-effect-free preview.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectContext } from "./project-context.js";
import { installRoot } from "./state.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop crew: ${msg}\n`);
    process.exit(1);
}
function warn(msg: string): void {
    process.stderr.write(`claude-loop crew: ${msg}\n`);
}

/** A crew name must be a safe single path/branch segment (no slash, space,
 *  dot-leading, etc.) so `worktrees/<name>` and `crew/<name>` stay well-formed. */
export function isValidCrewName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

/** Git branch for a crew: `crew/<name>`. */
export function crewBranch(name: string): string {
    return `crew/${name}`;
}

/** Crew consumer id, mirroring the house `<project>-<suffix>` convention. */
export function crewAgentId(project: string, name: string): string {
    return `${project}-crew-${name}`;
}

/** Absolute worktree path for a crew: `<root>/worktrees/<name>`. */
export function crewWorktreePath(root: string, name: string): string {
    return join(root, "worktrees", name);
}

export interface CrewProvisionPlan {
    name: string;
    project: string;
    agentId: string;
    branch: string;
    dir: string;
    /** Base ref the worktree branches from (default HEAD). */
    base: string;
}

/**
 * Pure: compute what `crew create <name>` WOULD provision — no side effects.
 * This is the tested core and the `--dry-run` output.
 */
export function crewProvisionPlan(args: {
    root: string;
    project: string;
    name: string;
    base?: string;
}): CrewProvisionPlan {
    return {
        name: args.name,
        project: args.project,
        agentId: crewAgentId(args.project, args.name),
        branch: crewBranch(args.name),
        dir: crewWorktreePath(args.root, args.name),
        base: args.base ?? "HEAD",
    };
}

function printPlan(plan: CrewProvisionPlan, willStart: boolean): void {
    process.stdout.write(
        `crew '${plan.name}' (${plan.project})\n` +
        `  worktree: ${plan.dir}\n` +
        `  branch:   ${plan.branch} (from ${plan.base})\n` +
        `  agent:    ${plan.agentId} (role=crew)\n` +
        `  start:    ${willStart ? "yes (--role crew, detached)" : "no (provision only)"}\n`,
    );
}

export interface CrewCreateOpts {
    start?: boolean;
    dryRun?: boolean;
    base?: string;
}

export function cmdCrewCreate(name: string, opts: CrewCreateOpts): void {
    if (!isValidCrewName(name)) {
        die(`invalid crew name '${name}' — use letters, digits, '-' or '_' (no slashes/spaces).`);
    }
    const ctx = resolveProjectContext();
    const plan = crewProvisionPlan({ root: ctx.cwd, project: ctx.project, name, base: opts.base });

    if (opts.dryRun) {
        process.stdout.write("(dry-run — no worktree created, no loop started)\n");
        printPlan(plan, opts.start === true);
        return;
    }

    // Provision the worktree (mirror of the sandbox pattern). Reuse if it
    // already exists — the worktree is recyclable per crew (david): keep its
    // context, just refresh best-effort.
    if (existsSync(plan.dir)) {
        process.stdout.write(`crew '${name}': reusing existing worktree ${plan.dir}\n`);
        const r = spawnSync("git", ["-C", plan.dir, "merge", "--ff-only", plan.base], { stdio: "inherit" });
        if (r.status !== 0) {
            // Diverged branch = normal project life; do NOT force-resolve here.
            warn(`refresh skipped for '${name}' (branch diverged from ${plan.base}) — resolve manually if needed.`);
        }
    } else {
        mkdirSync(dirname(plan.dir), { recursive: true });
        let r = spawnSync("git", ["worktree", "add", plan.dir, "-b", plan.branch, plan.base], { stdio: "inherit" });
        if (r.status !== 0) {
            // The branch may already exist (worktree was removed but the branch
            // wasn't) — retry attaching to the existing branch.
            r = spawnSync("git", ["worktree", "add", plan.dir, plan.branch], { stdio: "inherit" });
            if (r.status !== 0) die(`git worktree add failed for '${name}'.`);
        }
        process.stdout.write(`crew '${name}' created at ${plan.dir} (branch ${plan.branch})\n`);
    }

    if (opts.start) {
        // Detached launch (mirror of the daemon's loop spawn) so the crew loop
        // runs in its worktree without grabbing this terminal's tmux attach.
        const bin = join(installRoot(), "bin", "claude-loop");
        const child = spawn(
            bin,
            ["start", "--cwd", plan.dir, "--role", "crew", "--no-attach",
                "--consumer", plan.agentId, "--project", plan.project],
            { detached: true, stdio: "ignore" },
        );
        child.unref();
        process.stdout.write(`crew '${name}' loop starting (agent ${plan.agentId}, detached)\n`);
    } else {
        process.stdout.write(`  → start it with: claude-loop crew create ${name} --start\n`);
    }
}

interface WorktreeEntry {
    path: string;
    branch: string | null;
}

/** Parse `git worktree list --porcelain` output into entries. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
    const out: WorktreeEntry[] = [];
    let cur: Partial<WorktreeEntry> = {};
    for (const line of porcelain.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null });
            cur = { path: line.slice("worktree ".length).trim(), branch: null };
        } else if (line.startsWith("branch ")) {
            cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
        }
    }
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null });
    return out;
}

export function cmdCrewList(): void {
    const ctx = resolveProjectContext();
    const worktreesRoot = join(ctx.cwd, "worktrees");
    const r = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
    if (r.status !== 0) die("git worktree list failed (not a git repo?).");
    const crews = parseWorktreeList(r.stdout ?? "").filter((w) => w.path.startsWith(worktreesRoot + "/"));
    if (crews.length === 0) {
        process.stdout.write("(no crews)\n");
        return;
    }
    for (const w of crews) {
        const name = w.path.slice(worktreesRoot.length + 1);
        process.stdout.write(`${name.padEnd(20)}  ${(w.branch ?? "-").padEnd(24)}  ${w.path}\n`);
    }
}
