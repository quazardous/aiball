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
import { dirname, join, parse as parsePath, resolve } from "node:path";
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
    };
    /** Absolute path to the loaded `.aiball.yaml`, or null when none was found. */
    configPath: string | null;
}

const DEFAULTS: AiballConfig = {
    autopoll: {
        enabled: true,
        volatile: false,
        throttle_seconds: 30,
        include_recent_tickets: 3,
        backlog: true,
        tone: "directive",
    },
    consumer: {
        agent: null,
        project: null,
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

export function loadConfig(cwd: string = process.cwd()): AiballConfig {
    const configPath = findConfigUpwards(cwd);
    const projectDir = configPath ? dirname(configPath) : cwd;

    const cfg: AiballConfig = {
        ...DEFAULTS,
        autopoll: { ...DEFAULTS.autopoll },
        consumer: { ...DEFAULTS.consumer },
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
            if (typeof c.agent === "string" && c.agent) cfg.consumer.agent = c.agent;
            if (typeof c.project === "string" && c.project) cfg.consumer.project = c.project;
        } catch {
            /* malformed — fall back to defaults, hook stays silent */
        }
    }

    // Resolve agent/project: env > .aiball.json > .mcp.json. Cwd-hash
    // fallback is deliberately not used — without an explicit id,
    // we'd autopoll for a phantom consumer that has no pings anyway.
    if (!cfg.consumer.agent) {
        const fromEnv = process.env.AIBALL_AGENT;
        if (fromEnv) cfg.consumer.agent = fromEnv;
    }
    if (!cfg.consumer.agent) {
        cfg.consumer.agent = readMcpJsonAgent(projectDir);
    }
    if (!cfg.consumer.project) {
        const fromEnv = process.env.AIBALL_PROJECT;
        if (fromEnv) cfg.consumer.project = fromEnv;
    }
    if (!cfg.consumer.project) {
        cfg.consumer.project = readMcpJsonProject(projectDir);
    }

    return cfg;
}
