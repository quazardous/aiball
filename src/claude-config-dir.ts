/**
 * #4120 — the Claude Code config dir a project's loops run with: its account
 * or subscription, settings, MCP servers and sessions. One resolver for every
 * reader, so the loop that starts Claude and aiball's own reads of Claude's
 * files (the status line, the sessions offered for resume, a relocation) agree:
 *
 * 1. the project's `claude.config_dir` (`.aiball.yaml`, nearest up the tree, or
 *    the global config): `~` and paths relative to the folder are accepted;
 * 2. else the environment's `CLAUDE_CONFIG_DIR`;
 * 3. else `~/.claude`.
 *
 * Several projects may share one dir (a "profile"): nothing in the dir belongs
 * to a single project.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./autopoll/config.js";

export type ConfigDirFrom = "file" | "env" | "default";

export interface ClaudeConfigDir {
    /** The dir, absolute. */
    dir: string;
    /** Where Claude keeps its `.claude.json`: inside a chosen dir, in the home for the default one. */
    json: string;
    from: ConfigDirFrom;
}

/** A configured value as a path: `~` expanded, a relative path taken from the folder. */
export function expandConfigDir(raw: string, cwd: string, home: string = homedir()): string {
    const t = raw.trim();
    if (t === "~") return home;
    if (t.startsWith("~/")) return join(home, t.slice(2));
    return isAbsolute(t) ? t : resolve(cwd, t);
}

/** The Claude config dir a loop started in `cwd` runs with (no `cwd`: the environment's, else the default). */
export function claudeConfigDir(cwd?: string | null, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ClaudeConfigDir {
    let set: string | null = null;
    if (cwd) {
        try { set = loadConfig(cwd).claude.config_dir; } catch { /* an unreadable config: the layers below */ }
    }
    if (set) {
        const dir = expandConfigDir(set, cwd!, home);
        return { dir, json: join(dir, ".claude.json"), from: "file" };
    }
    const fromEnv = env.CLAUDE_CONFIG_DIR;
    if (fromEnv) return { dir: fromEnv, json: join(fromEnv, ".claude.json"), from: "env" };
    return { dir: join(home, ".claude"), json: join(home, ".claude.json"), from: "default" };
}
