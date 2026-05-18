/**
 * Single source for resolving the project context every claude-loop
 * subcommand needs: cwd + the aiball identity (agent, project).
 *
 * Resolution chain (#B.154, david 2026-05-18):
 *   1. `.aiball.yaml` `consumer.agent` — PRIMARY, canonical config
 *   2. `process.env.AIBALL_AGENT` — real override (shell export)
 *   3. `.mcp.json` `mcpServers.aiball.env.AIBALL_AGENT` — DEPRECATED
 *      fallback (legacy mechanism). When this kicks in,
 *      `warnIfDeprecated()` surfaces a one-line stderr nudge to
 *      migrate to `.aiball.yaml`.
 *   4. Default: `<basename(cwd)>-claude` — so claude-loop always has
 *      an identity to poll with, even on a bare project.
 *
 * Project name resolution is parallel: `.aiball.yaml` consumer.project
 * > `AIBALL_PROJECT` env > `.mcp.json`. No default — project name has
 * no obvious derivation and a missing one is fine (claude-loop
 * defaults to all-projects scope).
 *
 * The actual env / .mcp.json / .aiball.yaml parsing lives in
 * `src/autopoll/config.ts:loadConfig()` so the resolution logic
 * stays single-source (autopoll + claude-loop see the same identity).
 *
 * `applyToProcessEnv()` is the explicit side-effect callers opt into
 * when they need child processes (timer, hooks, claude itself) to
 * inherit the resolved identity.
 *
 * Before this module existed (#B.154 first pass), the resolution was
 * duplicated across cmdStart / cmdCheck / cmdTrace with subtle
 * differences — start used to skip the .mcp.json fallback entirely,
 * so the timer spawned with the WRONG consumer when launched from a
 * project dir without an explicit `AIBALL_AGENT=...` export. David:
 * "le bootstraping des variable d'env et du context projet
 * m'inquiete un peu / passe moi ça au peigne fin et refactor".
 */
import { basename } from "node:path";
import { loadConfig } from "../autopoll/config.js";

export type AgentSource = "aiball.yaml" | "env" | "mcp.json" | "default";

export interface ProjectContext {
    /** Absolute path to the project's working directory. */
    cwd: string;
    /** Resolved agent (consumer_id) — always set after default kicks in. */
    agent: string;
    /** Resolved project name. null when no source provided one. */
    project: string | null;
    /** Where the agent value came from (used for deprecation warning). */
    agent_source: AgentSource;
    /** Absolute path to the loaded `.aiball.yaml`, if any. */
    config_path: string | null;
}

interface ResolveOpts {
    cwd?: string;
}

export function resolveProjectContext(opts: ResolveOpts = {}): ProjectContext {
    const cwd = opts.cwd ?? process.env.CLAUDE_LOOP_CWD ?? process.cwd();
    const cfg = loadConfig(cwd);

    // loadConfig already walked: .aiball.yaml → env → .mcp.json. If
    // agent stays null, apply claude-loop's default so the loop always
    // has SOMETHING to identify with on aiball (the `<basename>-claude`
    // convention david laid out: project + client_name).
    let agent: string;
    let agent_source: AgentSource;
    if (cfg.consumer.agent) {
        agent = cfg.consumer.agent;
        agent_source = cfg.consumer.agent_source ?? "aiball.yaml";
    } else {
        agent = `${basename(cwd)}-claude`;
        agent_source = "default";
    }

    return {
        cwd,
        agent,
        project: cfg.consumer.project,
        agent_source,
        config_path: cfg.configPath,
    };
}

/**
 * Side effect: write the resolved agent/project back to process.env
 * so any child process the caller spawns inherits the right identity
 * (timer, claude, hooks). No-op when the field is null.
 */
export function applyToProcessEnv(ctx: ProjectContext): void {
    process.env.AIBALL_AGENT = ctx.agent;
    if (ctx.project) process.env.AIBALL_PROJECT = ctx.project;
}

/**
 * Surface a one-line deprecation warning on stderr when the agent
 * identity was resolved from `.mcp.json`'s env block (legacy path).
 * David's directive (#B.154): the new canonical source is
 * `.aiball.yaml` `consumer.agent` — `.mcp.json` env reading still
 * works but should nudge the user to migrate.
 *
 * Idempotent across a single process: the warning fires at most
 * once. Subcommands that wrap several internal context resolves
 * shouldn't spam stderr.
 */
let warnedOnce = false;
export function warnIfDeprecated(ctx: ProjectContext): void {
    if (warnedOnce) return;
    if (ctx.agent_source !== "mcp.json") return;
    warnedOnce = true;
    process.stderr.write(
        `[claude-loop] deprecation: AIBALL_AGENT='${ctx.agent}' was resolved from .mcp.json env block.\n` +
        `  Migrate to .aiball.yaml at the project root:\n\n` +
        `  consumer:\n    agent: ${ctx.agent}\n` +
        (ctx.project ? `    project: ${ctx.project}\n` : "") +
        `\n  See .aiball.yaml.example for the full template.\n`,
    );
}
