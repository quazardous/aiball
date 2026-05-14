/**
 * Load + parse `.aiball.json` from the project root (walks up from
 * cwd, like git/qcmp). All fields are optional — defaults applied at
 * read time. Missing file → returns the default shape, hook stays
 * silent.
 *
 * Schema (everything optional):
 * ```json
 * {
 *   "notify": {
 *     "enabled": true,
 *     "throttle_seconds": 0,
 *     "include_recent_tickets": 3,
 *     "tone": "directive"
 *   },
 *   "consumer": {
 *     "agent": "skybot-claude",
 *     "project": "skybot"
 *   }
 * }
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";

export type NotifyTone = "hint" | "directive" | "imperative";
const VALID_TONES: NotifyTone[] = ["hint", "directive", "imperative"];

export interface AiballConfig {
    notify: {
        enabled: boolean;
        throttle_seconds: number;
        include_recent_tickets: number;
        tone: NotifyTone;
    };
    consumer: {
        agent: string | null;
        project: string | null;
    };
    /** Absolute path to the loaded `.aiball.json`, or null when none was found. */
    configPath: string | null;
}

const DEFAULTS: AiballConfig = {
    notify: {
        enabled: true,
        throttle_seconds: 0,
        include_recent_tickets: 3,
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
        const candidate = join(dir, ".aiball.json");
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
        notify: { ...DEFAULTS.notify },
        consumer: { ...DEFAULTS.consumer },
        configPath,
    };

    if (configPath) {
        try {
            const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
            const n = (raw.notify ?? {}) as Record<string, unknown>;
            if (typeof n.enabled === "boolean") cfg.notify.enabled = n.enabled;
            if (typeof n.throttle_seconds === "number" && n.throttle_seconds >= 0) {
                cfg.notify.throttle_seconds = n.throttle_seconds;
            }
            if (typeof n.include_recent_tickets === "number" && n.include_recent_tickets >= 0) {
                cfg.notify.include_recent_tickets = Math.min(20, n.include_recent_tickets);
            }
            if (typeof n.tone === "string" && (VALID_TONES as string[]).includes(n.tone)) {
                cfg.notify.tone = n.tone as NotifyTone;
            }
            const c = (raw.consumer ?? {}) as Record<string, unknown>;
            if (typeof c.agent === "string" && c.agent) cfg.consumer.agent = c.agent;
            if (typeof c.project === "string" && c.project) cfg.consumer.project = c.project;
        } catch {
            /* malformed — fall back to defaults, hook will run with defaults */
        }
    }

    // Resolve agent/project: env > .aiball.json > .mcp.json. Cwd-hash
    // fallback is deliberately not used here — without an explicit id,
    // we'd notify a phantom consumer that has no pings anyway.
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
