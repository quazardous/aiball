/**
 * Single source for resolving the project context every claude-loop
 * subcommand needs: cwd + the aiball identity (agent, project).
 *
 * Resolution chain (#B.154, david 2026-05-18) — applied entirely in
 * `src/autopoll/config.ts:loadConfig()` so autopoll + claude-loop +
 * `aiball check` + MCP server all see the same identity:
 *
 *   1. `process.env.AIBALL_*` — priority, for special cases
 *   2. `.aiball.yaml consumer.*` — canonical, recommended
 *   3. `.mcp.json` mcpServers.aiball.env.* — DEPRECATED fallback
 *      (`warnIfDeprecated()` writes a stderr nudge)
 *   4. Defaults — project = `basename(cwd)`; agent = `<project>-claude`
 *
 * This module is the claude-loop-side thin wrapper around loadConfig
 * that also handles the side effects callers want (env mutation for
 * child processes, deprecation warning).
 */
import { loadConfig, type ConsumerSource } from "../autopoll/config.js";

export type AgentSource = ConsumerSource;

export interface ProjectContext {
    /** Absolute path to the project's working directory. */
    cwd: string;
    /** Resolved agent (consumer_id) — always set (default applied). */
    agent: string;
    /** Resolved project name — always set (default applied). */
    project: string;
    /** Where the agent value came from. */
    agent_source: AgentSource;
    /** Where the project value came from. */
    project_source: AgentSource;
    /** True when `.mcp.json` carries the deprecated identity env block. */
    mcp_json_deprecated: boolean;
    /** Absolute path to the loaded `.aiball.yaml`, if any. */
    config_path: string | null;
}

interface ResolveOpts {
    cwd?: string;
}

export function resolveProjectContext(opts: ResolveOpts = {}): ProjectContext {
    const cwd = opts.cwd ?? process.env.CLAUDE_LOOP_CWD ?? process.cwd();
    const cfg = loadConfig(cwd);
    // loadConfig now applies the `<project>-claude` default itself,
    // so both fields are guaranteed non-null here. The `!`s document
    // that invariant inline.
    return {
        cwd,
        agent: cfg.consumer.agent!,
        project: cfg.consumer.project!,
        agent_source: cfg.consumer.agent_source ?? "default",
        project_source: cfg.consumer.project_source ?? "default",
        mcp_json_deprecated: cfg.mcp_json_deprecated,
        config_path: cfg.configPath,
    };
}

/**
 * Side effect: write the resolved agent/project back to process.env
 * so any child process the caller spawns inherits the right identity
 * (timer, claude, hooks).
 */
export function applyToProcessEnv(ctx: ProjectContext): void {
    process.env.AIBALL_AGENT = ctx.agent;
    process.env.AIBALL_PROJECT = ctx.project;
}

/**
 * Surface a one-line deprecation warning on stderr when `.mcp.json`
 * carries the legacy mcpServers.aiball.env identity block. David's
 * #B.154 directive: that block must move to `.aiball.yaml`'s
 * `consumer:` section. Independent of where the resolved value came
 * from — presence-in-file is the trigger.
 *
 * Idempotent across a single process: warns at most once so
 * subcommands that wrap several context resolves don't spam.
 */
let warnedOnce = false;
export function warnIfDeprecated(ctx: ProjectContext): void {
    if (warnedOnce) return;
    if (!ctx.mcp_json_deprecated) return;
    warnedOnce = true;
    process.stderr.write(
        `[claude-loop] deprecation: .mcp.json has an mcpServers.aiball.env block (legacy identity source).\n` +
        `  Migrate to .aiball.yaml at the project root:\n\n` +
        `  consumer:\n    agent: ${ctx.agent}\n    project: ${ctx.project}\n` +
        `\n  Then drop the env block from .mcp.json. See .aiball.yaml.example.\n`,
    );
}
