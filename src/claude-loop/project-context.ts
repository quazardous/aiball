/**
 * Single source for resolving the project context every claude-loop
 * subcommand needs: cwd + the aiball identity (agent, project).
 *
 * Resolution chain (#B.154, david 2026-05-18):
 *   1. `process.env.AIBALL_*` — priority, for special cases
 *   2. `.aiball.yaml consumer.*` — canonical, recommended
 *   3. `.mcp.json` mcpServers.aiball.env.* — DEPRECATED legacy
 *      fallback. `warnIfDeprecated()` surfaces a stderr nudge when
 *      `.mcp.json` carries the env block (presence-in-file, not
 *      value origin).
 *   4. Defaults (claude-loop-specific, applied here on top of
 *      loadConfig's null returns):
 *      - project: `basename(cwd)`
 *      - agent:   `<resolved-project>-<cli_name>` (cli_name="claude")
 *
 * The actual env / .mcp.json / .aiball.yaml parsing lives in
 * `src/autopoll/config.ts:loadConfig()` so the resolution logic stays
 * single-source (autopoll + claude-loop + `aiball check` all see the
 * same identity).
 *
 * `applyToProcessEnv()` is the explicit side-effect callers opt into
 * when they need child processes (timer, hooks, claude itself) to
 * inherit the resolved identity.
 *
 * Before this module existed (#B.154 first pass), the resolution was
 * duplicated across cmdStart / cmdCheck / cmdTrace with subtle
 * drift — cmdStart used to skip the .mcp.json fallback entirely, so
 * the timer spawned with the WRONG consumer when launched from a
 * project dir without an explicit `AIBALL_AGENT=...` export. David:
 * "le bootstraping des variable d'env et du context projet
 * m'inquiete un peu / passe moi ça au peigne fin et refactor".
 */
import { basename } from "node:path";
import { loadConfig } from "../autopoll/config.js";

export type AgentSource = "env" | "aiball.yaml" | "mcp.json" | "default";

/** The CLI being driven by the loop. Folded into the agent default
 *  (`<project>-<cli_name>`). Only "claude" today; keep it explicit
 *  so adding a sibling loop (cursor-loop, qcmp-loop, …) is one
 *  parameter, not a fork of this file. */
const CLI_NAME = "claude";

export interface ProjectContext {
    /** Absolute path to the project's working directory. */
    cwd: string;
    /** Resolved agent (consumer_id) — always set after default kicks in. */
    agent: string;
    /** Resolved project name — always set after default kicks in. */
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

    // Project default = basename(cwd) per david's #B.154 directive.
    let project: string;
    let project_source: AgentSource;
    if (cfg.consumer.project) {
        project = cfg.consumer.project;
        project_source = cfg.consumer.project_source ?? "aiball.yaml";
    } else {
        project = basename(cwd);
        project_source = "default";
    }

    // Agent default = `<project>-<cli_name>`. The project here is the
    // RESOLVED one (env > yaml > basename), so the agent default
    // tracks however the project was set. Matches david's "AIBALL_AGENT
    // par defaut AIBALL_PROJECT '-' nom du cli (ex claude)".
    let agent: string;
    let agent_source: AgentSource;
    if (cfg.consumer.agent) {
        agent = cfg.consumer.agent;
        agent_source = cfg.consumer.agent_source ?? "aiball.yaml";
    } else {
        agent = `${project}-${CLI_NAME}`;
        agent_source = "default";
    }

    return {
        cwd,
        agent,
        project,
        agent_source,
        project_source,
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
