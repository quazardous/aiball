/**
 * Single source for resolving the project context every claude-loop
 * subcommand needs: cwd + the aiball identity (agent, project)
 * derived from env vars and (optionally) the `.mcp.json` in the cwd.
 *
 * Before this module existed (#B.154), the resolution was
 * duplicated across cmdStart / cmdCheck / cmdTrace with subtle
 * differences — start used to skip the .mcp.json fallback entirely,
 * so the timer spawned with the WRONG consumer when launched from a
 * project dir without an explicit `AIBALL_AGENT=...` export. David:
 * "le bootstraping des variable d'env et du context projet
 * m'inquiete un peu / passe moi ça au peigne fin et refactor".
 *
 * Resolution order for each field (first hit wins):
 *   1. opts.cwd / process.env.CLAUDE_LOOP_CWD / process.cwd()
 *   2. process.env.AIBALL_AGENT / AIBALL_PROJECT (already set)
 *   3. mcpServers.aiball.env in `.mcp.json` at cwd
 *
 * `applyToProcessEnv()` is the explicit side-effect callers opt into
 * when they need child processes (timer, hooks, claude itself) to
 * inherit the resolved identity. Pure read = no env mutation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectContext {
    /** Absolute path to the project's working directory. */
    cwd: string;
    /** Resolved agent (consumer_id). null when no source provides one. */
    agent: string | null;
    /** Resolved project name. null when no source provides one. */
    project: string | null;
    /** Path of the `.mcp.json` that contributed defaults, or null. */
    mcpJsonPath: string | null;
}

interface ResolveOpts {
    cwd?: string;
}

export function resolveProjectContext(opts: ResolveOpts = {}): ProjectContext {
    const cwd = opts.cwd ?? process.env.CLAUDE_LOOP_CWD ?? process.cwd();
    let agent: string | null = process.env.AIBALL_AGENT ?? null;
    let project: string | null = process.env.AIBALL_PROJECT ?? null;
    const mcpJsonPath = join(cwd, ".mcp.json");
    let resolvedMcp: string | null = null;
    if (existsSync(mcpJsonPath)) {
        try {
            const raw = readFileSync(mcpJsonPath, "utf8");
            const j = JSON.parse(raw) as {
                mcpServers?: { aiball?: { env?: Record<string, string> } };
            };
            const env = j.mcpServers?.aiball?.env;
            if (env) {
                if (!agent && env.AIBALL_AGENT) agent = env.AIBALL_AGENT;
                if (!project && env.AIBALL_PROJECT) project = env.AIBALL_PROJECT;
                resolvedMcp = mcpJsonPath;
            }
        } catch { /* malformed json — ignore */ }
    }
    return { cwd, agent, project, mcpJsonPath: resolvedMcp };
}

/**
 * Side effect: write the resolved agent/project back to process.env
 * so any child process the caller spawns inherits the right identity
 * (timer, claude, hooks). No-op when the field is null.
 */
export function applyToProcessEnv(ctx: ProjectContext): void {
    if (ctx.agent) process.env.AIBALL_AGENT = ctx.agent;
    if (ctx.project) process.env.AIBALL_PROJECT = ctx.project;
}
