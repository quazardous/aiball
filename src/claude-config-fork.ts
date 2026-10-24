/**
 * #4125 — fork a Claude config dir: the new one starts with the old one's mind
 * (how Claude works: instructions, skills, settings), never its identity (the
 * account) nor its past (sessions, history). For `aiball claude-config <dir>
 * --fork`, when a project moves to its own dir — its own account — and should
 * keep working the way the others do.
 *
 * Every entry of a Claude config dir is ranged here, with why: what is not in
 * FORKED is not carried, and the command says so, so an entry a later Claude
 * Code adds is seen and ranged rather than silently carried over.
 *
 * #4126 — carried by symbolic link by default, so the next update of a skill or
 * of CLAUDE.md reaches every dir; `copy` makes the new dir its own. What Claude
 * itself writes (WRITTEN_BY_CLAUDE) is copied either way. An entry replaced
 * (`force`) is moved aside into `.replaced-by-fork-<date>/`, never deleted.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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

/** Copied even when the rest is linked: Claude writes them, and through a link one dir would rewrite every other's. */
export const WRITTEN_BY_CLAUDE: Record<string, string> = {
    "settings.json": "/config, the theme, the permissions granted with \"always allow\"",
    // #4216 — per account: the marketplaces each dir clones, the folders it syncs with its account.
    "plugins": "the marketplaces, their clones and the account's sync, under the dir's own absolute paths",
};

/**
 * #4216 — in `plugins/`, what Claude rebuilds and what belongs to one account:
 * left out of the copy. The rest (`known_marketplaces.json`,
 * `installed_plugins.json`, the `marketplaces/` clones, `data/`) is the user's
 * choice and goes, its absolute paths into the old dir rewritten to the new one.
 */
export const PLUGINS_LEFT_OUT: Record<string, string> = {
    "synced": "the folders Claude syncs with this dir's account",
    "plugin-directory-cache-v2.json": "cache",
    "plugin-catalog-cache.json": "cache",
    "blocklist.json": "cache",
};

/** Never carried: the identity and the past. */
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
    /** Linked to the old dir's entry (or already were). */
    linked: string[];
    copied: string[];
    /** Already in the new dir, left as it was (no `force`). */
    kept: string[];
    /** Replaced (`force`): the new dir's own, moved into this folder. */
    movedAside: string | null;
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

export function forkClaudeConfig(
    from: { dir: string; json: string },
    to: { dir: string; json: string },
    opts: { force?: boolean; copy?: boolean; now?: Date } = {},
): ForkResult {
    const out: ForkResult = { linked: [], copied: [], kept: [], movedAside: null, unknown: [], mcpServers: 0 };
    if (!existsSync(from.dir)) return out;
    mkdirSync(to.dir, { recursive: true });
    const imports = importedMarkdown(from.dir);
    const aside = join(to.dir, `.replaced-by-fork-${(opts.now ?? new Date()).toISOString().slice(0, 10)}`);
    for (const name of readdirSync(from.dir).sort()) {
        const forked = name in FORKED || imports.includes(name);
        if (!forked) {
            // Backups and scratch copies (`settings.json.bak`, `*.bak-…`) are not the mind either.
            if (!(name in NEVER) && !/\.(bak|old)\b|\.bak-/.test(name) && !name.startsWith(".")) out.unknown.push(name);
            continue;
        }
        const source = resolve(from.dir, name);
        const target = join(to.dir, name);
        const link = !opts.copy && !(name in WRITTEN_BY_CLAUDE);
        const present = lstatOrNull(target);
        if (present) {
            if (link && present.isSymbolicLink() && resolve(to.dir, readlinkSync(target)) === source) { out.linked.push(name); continue; }
            if (!opts.force) { out.kept.push(name); continue; }
            mkdirSync(aside, { recursive: true });
            renameSync(target, join(aside, name));
            out.movedAside = aside;
        }
        const dir = statSync(source).isDirectory();
        if (link) {
            try {
                // A junction on Windows, where a plain symlink needs a privilege; ignored elsewhere.
                symlinkSync(source, target, dir ? "junction" : "file");
                out.linked.push(name);
                continue;
            } catch { /* no symlink here: copied instead */ }
        }
        if (name === "plugins" && dir) copyPlugins(source, target, from.dir, to.dir);
        else cpSync(source, target, { recursive: dir, force: true });
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

/** #4216 — `plugins/` copied without what Claude rebuilds, the old dir's paths rewritten to the new one. */
function copyPlugins(source: string, target: string, fromDir: string, toDir: string): void {
    cpSync(source, target, {
        recursive: true,
        force: true,
        filter: (src) => {
            const top = relative(source, src).split(sep)[0];
            return !(top in PLUGINS_LEFT_OUT);
        },
    });
    // The registries record where each marketplace and plugin lives, as absolute paths.
    const olds = [...new Set([resolve(fromDir), realpathOrSelf(fromDir)])];
    const quote = (p: string) => JSON.stringify(p).slice(1, -1);
    for (const name of readdirSync(target)) {
        if (!name.endsWith(".json")) continue;
        const file = join(target, name);
        const text = readFileSync(file, "utf8");
        let next = text;
        for (const old of olds) next = next.split(quote(old + sep)).join(quote(resolve(toDir) + sep));
        if (next !== text) writeFileSync(file, next);
    }
}

function realpathOrSelf(p: string): string {
    try { return realpathSync(p); } catch { return resolve(p); }
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
    try { return lstatSync(p); } catch { return null; }
}
