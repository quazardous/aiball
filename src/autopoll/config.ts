/**
 * Load + parse `.aiball.yaml` from the project root (walks up from
 * cwd, like git/qcmp). All fields are optional — defaults applied at
 * read time. Missing file → autopoll disabled, hook stays silent.
 *
 * YAML is preferred over JSON because the file is meant to be
 * human-edited and commented — see `.aiball.yaml.example` at the
 * repo root for the canonical annotated template.
 *
 * Schema (everything optional):
 * ```yaml
 * autopoll:
 *   enabled: true
 *   throttle_seconds: 0
 *   include_recent_tickets: 3
 *   tone: directive
 * consumer:
 *   agent: skybot-claude
 *   project: skybot
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const CONFIG_FILENAME = ".aiball.yaml";

export type AutopollTone = "hint" | "directive" | "imperative";
const VALID_TONES: AutopollTone[] = ["hint", "directive", "imperative"];

export interface AiballConfig {
    autopoll: {
        enabled: boolean;
        /**
         * `false` (default) — reminders persist: re-notify when
         * `throttle_seconds` elapses even if you didn't drain. New
         * pings (max_id moves) always notify immediately, bypassing
         * the throttle.
         * `true` — one-shot: notify only when max_id moves. No
         * time-based reminders. Use when you want "tell me once and
         * leave me alone".
         */
        volatile: boolean;
        throttle_seconds: number;
        include_recent_tickets: number;
        /**
         * Include the open-tickets count for the consumer's project
         * in the notify reason. Default true — gives the agent
         * project-level context beyond personal pings.
         */
        backlog: boolean;
        tone: AutopollTone;
    };
    consumer: {
        agent: string | null;
        project: string | null;
        /**
         * Which source the resolved value came from. Lets callers
         * surface diagnostics and warn on the deprecated path.
         */
        agent_source: ConsumerSource | null;
        project_source: ConsumerSource | null;
    };
    /**
     * True when `.mcp.json` next to the config carries an
     * `mcpServers.aiball.env` block with AIBALL_AGENT or AIBALL_PROJECT
     * (#B.154, david 2026-05-18). The block is the legacy injection
     * mechanism — `.aiball.yaml` `consumer:` is the new canonical
     * source. Callers (`aiball check`, `claude-loop`) surface a
     * deprecation nudge when this flag is set.
     */
    mcp_json_deprecated: boolean;
    /**
     * #B.180 david: all claude-loop timeouts are yaml-configurable.
     * CLI flags (`--interval`, `--user-grace`) still win when passed;
     * env vars (`CL_*`) override yaml on the timer/hook child
     * processes. All values are seconds (ms in the schema would be
     * confusing — internal conversion happens at the consumption
     * site for BOOT_GRACE_MS / WAKE_IN_FLIGHT_TTL_MS).
     */
    claude_loop: {
        /** Heartbeat tick in seconds. CL_INTERVAL. */
        interval_seconds: number;
        /** Boot-grace before settleBoot fires. CL_BOOT_GRACE_SEC. */
        boot_grace_seconds: number;
        /** User-took-over grace window. CL_USER_GRACE_SEC. */
        user_grace_seconds: number;
        /** Wake-in-flight marker TTL (#B.180). CL_WAKE_IN_FLIGHT_TTL_MS. */
        wake_in_flight_ttl_ms: number;
    };
    /** Absolute path to the loaded `.aiball.yaml`, or null when none was found. */
    configPath: string | null;
}

export type ConsumerSource = "env" | "aiball.yaml" | "mcp.json" | "default";

const DEFAULTS: AiballConfig = {
    autopoll: {
        enabled: true,
        volatile: false,
        // 120s so fast back-and-forth doesn't re-fire the standing
        // reminder every turn; new-ping/new-open triggers still
        // bypass the throttle (#B.192).
        throttle_seconds: 120,
        include_recent_tickets: 3,
        backlog: true,
        tone: "directive",
    },
    consumer: {
        agent: null,
        project: null,
        agent_source: null,
        project_source: null,
    },
    mcp_json_deprecated: false,
    claude_loop: {
        // Heartbeat 30s, grace windows 60s — coherent order of
        // magnitude, all yaml-overridable (#B.180, #B.185).
        interval_seconds: 30,
        boot_grace_seconds: 60,
        user_grace_seconds: 60,
        wake_in_flight_ttl_ms: 2000,
    },
    configPath: null,
};

export function findConfigUpwards(start: string): string | null {
    let dir = resolve(start);
    const rootPath = parsePath(dir).root;
    for (let i = 0; i < 64; i++) {
        const candidate = join(dir, CONFIG_FILENAME);
        if (existsSync(candidate)) return candidate;
        if (dir === rootPath) return null;
        const next = dirname(dir);
        if (next === dir) return null;
        dir = next;
    }
    return null;
}

/**
 * Last-resort: if `.aiball.json` doesn't carry a `consumer.agent`,
 * peek at `.mcp.json` in the same dir for `mcpServers.aiball.env.AIBALL_AGENT`.
 * Most users already have aiball wired there, so this avoids
 * duplicating the value.
 */
function readMcpJsonAgent(dir: string): string | null {
    const p = join(dir, ".mcp.json");
    if (!existsSync(p)) return null;
    try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
        const env = raw.mcpServers?.aiball?.env;
        return env?.AIBALL_AGENT ?? null;
    } catch {
        return null;
    }
}

function readMcpJsonProject(dir: string): string | null {
    const p = join(dir, ".mcp.json");
    if (!existsSync(p)) return null;
    try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
        const env = raw.mcpServers?.aiball?.env;
        return env?.AIBALL_PROJECT ?? null;
    } catch {
        return null;
    }
}

/**
 * True when `.mcp.json` at the project dir has an
 * `mcpServers.aiball.env` block that carries AIBALL_AGENT or
 * AIBALL_PROJECT. Independent of where the *resolved* value came
 * from — drives the deprecation warning since presence-in-file is
 * what david wants to flag (#B.154).
 */
function mcpJsonHasIdentityEnv(dir: string): boolean {
    const p = join(dir, ".mcp.json");
    if (!existsSync(p)) return false;
    try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
        const env = raw.mcpServers?.aiball?.env;
        if (!env) return false;
        return !!(env.AIBALL_AGENT || env.AIBALL_PROJECT);
    } catch {
        return false;
    }
}

export function loadConfig(cwd: string = process.cwd()): AiballConfig {
    const configPath = findConfigUpwards(cwd);
    const projectDir = configPath ? dirname(configPath) : cwd;

    const cfg: AiballConfig = {
        ...DEFAULTS,
        autopoll: { ...DEFAULTS.autopoll },
        consumer: { ...DEFAULTS.consumer },
        claude_loop: { ...DEFAULTS.claude_loop },
        mcp_json_deprecated: mcpJsonHasIdentityEnv(projectDir),
        configPath,
    };

    // No .aiball.json → autopoll disabled. The hook wiring in
    // ~/.claude/settings.json is global; per-project opt-in lives in
    // the file. Drop a `{}` in at the project root to activate with
    // sensible defaults; override individual fields as needed.
    if (!configPath) {
        cfg.autopoll.enabled = false;
    }

    if (configPath) {
        try {
            const raw = (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
            const a = (raw.autopoll ?? {}) as Record<string, unknown>;
            if (typeof a.enabled === "boolean") cfg.autopoll.enabled = a.enabled;
            if (typeof a.volatile === "boolean") cfg.autopoll.volatile = a.volatile;
            if (typeof a.backlog === "boolean") cfg.autopoll.backlog = a.backlog;
            if (typeof a.throttle_seconds === "number" && a.throttle_seconds >= 0) {
                cfg.autopoll.throttle_seconds = a.throttle_seconds;
            }
            if (typeof a.include_recent_tickets === "number" && a.include_recent_tickets >= 0) {
                cfg.autopoll.include_recent_tickets = Math.min(20, a.include_recent_tickets);
            }
            if (typeof a.tone === "string" && (VALID_TONES as string[]).includes(a.tone)) {
                cfg.autopoll.tone = a.tone as AutopollTone;
            }
            const c = (raw.consumer ?? {}) as Record<string, unknown>;
            if (typeof c.agent === "string" && c.agent) {
                cfg.consumer.agent = c.agent;
                cfg.consumer.agent_source = "aiball.yaml";
            }
            if (typeof c.project === "string" && c.project) {
                cfg.consumer.project = c.project;
                cfg.consumer.project_source = "aiball.yaml";
            }
            // #B.180 david: all claude-loop timeouts configurable.
            const cl = (raw.claude_loop ?? {}) as Record<string, unknown>;
            if (typeof cl.interval_seconds === "number" && cl.interval_seconds > 0) {
                cfg.claude_loop.interval_seconds = cl.interval_seconds;
            }
            if (typeof cl.boot_grace_seconds === "number" && cl.boot_grace_seconds >= 0) {
                cfg.claude_loop.boot_grace_seconds = cl.boot_grace_seconds;
            }
            if (typeof cl.user_grace_seconds === "number" && cl.user_grace_seconds >= 0) {
                cfg.claude_loop.user_grace_seconds = cl.user_grace_seconds;
            }
            if (typeof cl.wake_in_flight_ttl_ms === "number" && cl.wake_in_flight_ttl_ms > 0) {
                cfg.claude_loop.wake_in_flight_ttl_ms = cl.wake_in_flight_ttl_ms;
            }
        } catch {
            /* malformed — fall back to defaults, hook stays silent */
        }
    }

    // Resolution chain (#B.154, david 2026-05-18):
    //   1. process.env.AIBALL_*  ← priority, for special cases
    //   2. .aiball.yaml consumer.*  ← canonical, recommended
    //   3. .mcp.json mcpServers.aiball.env.*  ← DEPRECATED, warned via
    //      mcp_json_deprecated (presence-in-file, independent of
    //      whether the value was actually used here)
    //
    // Env wins over yaml because david's framing is: env is the legit
    // override path ("prioritaire mais utilisé pour cas particulier").
    // Yaml is what most users set; env is the temporary override.
    //
    // No defaults applied at this layer — autopoll treats null-agent
    // as "stay silent", which is the right semantic for that surface.
    // Callers that need a fallback (claude-loop, mcp server) apply
    // their own default on top of this resolved value.
    const envAgent = process.env.AIBALL_AGENT;
    if (envAgent) {
        cfg.consumer.agent = envAgent;
        cfg.consumer.agent_source = "env";
    }
    if (!cfg.consumer.agent) {
        const fromMcp = readMcpJsonAgent(projectDir);
        if (fromMcp) {
            cfg.consumer.agent = fromMcp;
            cfg.consumer.agent_source = "mcp.json";
        }
    }
    const envProject = process.env.AIBALL_PROJECT;
    if (envProject) {
        cfg.consumer.project = envProject;
        cfg.consumer.project_source = "env";
    }
    if (!cfg.consumer.project) {
        const fromMcp = readMcpJsonProject(projectDir);
        if (fromMcp) {
            cfg.consumer.project = fromMcp;
            cfg.consumer.project_source = "mcp.json";
        }
    }

    // Final defaults (#B.154 david): project = basename(cwd),
    // agent = `<project>-claude`. Single source so every consumer
    // (autopoll, claude-loop, MCP server, aiball CLI) sees the same
    // identity when nothing else resolves. Autopoll's "stay silent"
    // signal moved off `!consumer.agent` (was redundant) to the
    // proper gate: `!autopoll.enabled`, which is false when no
    // .aiball.yaml is found.
    if (!cfg.consumer.project) {
        cfg.consumer.project = basename(projectDir);
        cfg.consumer.project_source = "default";
    }
    if (!cfg.consumer.agent) {
        cfg.consumer.agent = `${cfg.consumer.project}-claude`;
        cfg.consumer.agent_source = "default";
    }

    return cfg;
}
