/**
 * #4125 — fork a Claude config dir: the new one starts with the old one's mind
 * (how Claude works: instructions, skills, settings), never its identity (the
 * account) nor its past (sessions, history). For `aiball claude-config <dir>
 * --fork`, when a project moves to its own dir — its own account — and should
 * keep working the way the others do.
 *
 * Every entry of a Claude config dir is ranged here, with why: what is not in
 * FORKED is not copied, and the command says so, so an entry a later Claude Code
 * adds is seen and ranged rather than silently carried over.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Copied: how Claude works. */
export const FORKED: Record<string, string> = {
    "CLAUDE.md": "the global instructions",
    "settings.json": "permissions, hooks, status line, model",
    "keybindings.json": "key bindings",
    "skills": "skills",
    "agents": "subagents",
    "commands": "slash commands",
    "output-styles": "output styles",
    "plugins": "plugins and their marketplaces",
    "hooks": "hook scripts settings.json may name",
};

/** Never copied: the identity and the past. */
export const NEVER: Record<string, string> = {
    ".credentials.json": "the account's credentials: the new dir logs in on its own",
    ".claude.json": "the account and first-run state; only its mcpServers are carried",
    "projects": "sessions: --move-sessions moves a project's",
    "history.jsonl": "prompt history",
    "todos": "per-session task lists",
    "shell-snapshots": "per-session shell state",
    "file-history": "per-session file history",
    "session-env": "per-session environment",
    "sessions": "session state",
    "paste-cache": "cache",
    "cache": "cache",
    "stats-cache.json": "cache",
    "statsig": "telemetry state",
    "debug": "logs",
    "ide": "IDE lock files of running sessions",
    "jobs": "background jobs of this dir's sessions",
    "daemon": "this dir's background daemon",
    "daemon.lock": "this dir's background daemon",
    "daemon.log": "this dir's background daemon",
    "daemon.status.json": "this dir's background daemon",
    "bridge-spawn": "runtime state",
    "state": "runtime state",
    "backups": "Claude's own backups of this dir",
    "remote-settings.json": "settings the account receives from its organisation",
    "remote-settings.json.synced-at": "settings the account receives from its organisation",
    "chrome": "the Chrome extension's link to this account",
    "feedback": "runtime state",
};

export interface ForkResult {
    copied: string[];
    /** Already in the new dir, left as it was (no `force`). */
    kept: string[];
    /** Neither forked nor never: an entry this table does not know. */
    unknown: string[];
    /** `mcpServers` of `.claude.json` carried. */
    mcpServers: number;
}

/**
 * The root `.md` files CLAUDE.md imports (`@RTK.md`), copied with it: an import
 * left behind would fail in the new dir.
 */
function importedMarkdown(fromDir: string): string[] {
    let text = "";
    try { text = readFileSync(join(fromDir, "CLAUDE.md"), "utf8"); } catch { return []; }
    const out = new Set<string>();
    for (const m of text.matchAll(/(?:^|\s)@([\w.-]+\.md)\b/g)) {
        if (existsSync(join(fromDir, m[1]))) out.add(m[1]);
    }
    return [...out];
}

export function forkClaudeConfig(from: { dir: string; json: string }, to: { dir: string; json: string }, opts: { force?: boolean } = {}): ForkResult {
    const out: ForkResult = { copied: [], kept: [], unknown: [], mcpServers: 0 };
    if (!existsSync(from.dir)) return out;
    mkdirSync(to.dir, { recursive: true });
    const imports = importedMarkdown(from.dir);
    for (const name of readdirSync(from.dir).sort()) {
        const forked = name in FORKED || imports.includes(name);
        if (!forked) {
            // Backups and scratch copies (`settings.json.bak`, `*.bak-…`) are not the mind either.
            if (!(name in NEVER) && !/\.(bak|old)\b|\.bak-/.test(name) && !name.startsWith(".")) out.unknown.push(name);
            continue;
        }
        const target = join(to.dir, name);
        if (existsSync(target) && !opts.force) { out.kept.push(name); continue; }
        cpSync(join(from.dir, name), target, { recursive: statSync(join(from.dir, name)).isDirectory(), force: true });
        out.copied.push(name);
    }
    // The user-scope MCP servers live in .claude.json, beside the account: only they go.
    try {
        const src = JSON.parse(readFileSync(from.json, "utf8")) as { mcpServers?: Record<string, unknown> };
        const servers = src.mcpServers && typeof src.mcpServers === "object" ? src.mcpServers : {};
        if (Object.keys(servers).length > 0) {
            let dst: Record<string, unknown> = {};
            try { dst = JSON.parse(readFileSync(to.json, "utf8")) as Record<string, unknown>; } catch { /* none yet */ }
            const mine = (dst.mcpServers && typeof dst.mcpServers === "object" ? dst.mcpServers : {}) as Record<string, unknown>;
            for (const [k, v] of Object.entries(servers)) {
                if (k in mine && !opts.force) continue;
                mine[k] = v;
                out.mcpServers++;
            }
            if (out.mcpServers > 0) {
                dst.mcpServers = mine;
                writeFileSync(to.json, JSON.stringify(dst, null, 2));
            }
        }
    } catch { /* no .claude.json in the old dir: no user MCP server */ }
    return out;
}
