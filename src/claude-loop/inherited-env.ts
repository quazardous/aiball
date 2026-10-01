/**
 * #3175 — `claude-loop start` run from a shell inside another loop (an agent
 * starting a crew, a test from an agent's Bash) inherits that loop's
 * environment: its `CL_*` (`CL_HOST_CONTROL` — the new loop drove the calling
 * loop's session host and typed its start-up prompt into that Claude —,
 * `CL_STATE_DIR`, its settings) and its identity (`AIBALL_AGENT`, `_PROJECT`,
 * `_CWD`…). None of it is the new loop's: it is dropped before anything reads
 * it. What reaches the daemon (`AIBALL_SOCK`, `_URL`, `_TOKEN`, `_HOME`) stays.
 *
 * A variable set on purpose on the command (`CL_CLAUDE_CMD=… claude-loop
 * start`) is told from an inherited one by the parent's own record: the
 * parent loop wrote what it runs with in its state dir (`env`, `env.local`).
 * A value that matches that record is the parent's; one that differs, or that
 * the parent never set, was meant. With no record to read, everything goes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The loop identity a parent loop leaves in its shell, besides its `CL_*`. */
export const INHERITED_IDENTITY_KEYS = [
    "AIBALL_AGENT",
    "AIBALL_PROJECT",
    "AIBALL_CWD",
    "AIBALL_PROJECT_CWD",
    "AIBALL_SESSION_KEY",
    "AIBALL_SESSION_MODE",
] as const;

/** Keys that are always a loop's own, whatever their value: never carried over. */
const ALWAYS_THE_PARENTS = new Set(["CL_STATE_DIR", "CL_NAME", "CL_TMUX", "CL_PINGS", "CL_HOST_CONTROL"]);

/** `export KEY='value'` lines of a loop's env file, unquoted; null when it cannot be read. */
export function readLoopEnvFile(path: string): Record<string, string> | null {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const m = /^export ([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (!m) continue;
        const raw = m[2]!;
        out[m[1]!] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
    }
    return out;
}

/** What the loop at `sd` runs with: its `env`, then its `env.local` over it; null with neither. */
export function parentRecord(sd: string): Record<string, string> | null {
    const env = readLoopEnvFile(join(sd, "env"));
    const local = readLoopEnvFile(join(sd, "env.local"));
    if (!env && !local) return null;
    return { ...(env ?? {}), ...(local ?? {}) };
}

/**
 * When `env` is inside a loop (it carries `CL_STATE_DIR`), drop what it
 * inherited from that loop; say which loop, and what went. Otherwise, change
 * nothing.
 */
export function dropInheritedLoopEnv(
    env: NodeJS.ProcessEnv,
    readRecord: (sd: string) => Record<string, string> | null = parentRecord,
): { from: string; dropped: string[] } | null {
    const from = env.CL_STATE_DIR;
    if (!from) return null;
    const record = readRecord(from);
    const dropped: string[] = [];
    for (const k of Object.keys(env)) {
        const loopKey = k.startsWith("CL_") || (INHERITED_IDENTITY_KEYS as readonly string[]).includes(k);
        if (!loopKey) continue;
        const inherited = ALWAYS_THE_PARENTS.has(k) || !record || record[k] === env[k];
        if (!inherited) continue;
        delete env[k];
        dropped.push(k);
    }
    return { from, dropped };
}

/**
 * #3460 — the markers a Claude Code session leaves in the shells it runs: who
 * it is (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`), that it is one (`CLAUDECODE`,
 * `CLAUDE_CODE_CHILD_SESSION`, which turns transcript saving off in a Claude
 * started under it), how to reach it (`CLAUDE_CODE_MESSAGING_*`, a token
 * included). A loop started from such a shell is not that session's child.
 * A closed list: the rest of `CLAUDE_CODE_*` holds settings meant for every
 * Claude (`CLAUDE_CODE_USE_BEDROCK`), the loop's own among them.
 */
export const CLAUDE_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_[A-Z0-9_]+|CHILD_SESSION|ENTRYPOINT|EXECPATH|BRIDGE_[A-Z0-9_]+|MESSAGING_[A-Z0-9_]+))$/;

/** Drop the Claude Code session markers from `env`; the names dropped. */
export function dropClaudeSessionEnv(env: NodeJS.ProcessEnv): string[] {
    const dropped = Object.keys(env).filter((k) => CLAUDE_SESSION_ENV.test(k));
    for (const k of dropped) delete env[k];
    return dropped;
}

/**
 * The same, in the loop's env file, sourced right before Claude: a tmux server
 * started from a Claude session hands its markers to every pane it opens,
 * whatever the environment of the `start` that asked for it.
 */
export const UNSET_CLAUDE_SESSION_SH =
    `__cl_re='${CLAUDE_SESSION_ENV.source}'; for __cl_v in $(compgen -e); do [[ $__cl_v =~ $__cl_re ]] && unset "$__cl_v"; done; unset __cl_re __cl_v`;
