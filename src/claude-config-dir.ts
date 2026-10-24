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
import { existsSync, readFileSync } from "node:fs";
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

/**
 * #4209 — a dir named by hand (a fork's source): ~/.claude keeps its
 * .claude.json beside it, in the home, as Claude does without CLAUDE_CONFIG_DIR.
 */
export function sourceDir(dir: string, home: string = homedir()): { dir: string; json: string } {
    const inside = join(dir, ".claude.json");
    if (resolve(dir) === join(home, ".claude") && !existsSync(inside)) return { dir, json: join(home, ".claude.json") };
    return { dir, json: inside };
}

/** #4120 — a `.claude.json` that has been through Claude's first run (theme, login, …). */
export function onboardingDone(jsonText: string | null): boolean {
    if (jsonText === null) return false;
    try { return (JSON.parse(jsonText) as { hasCompletedOnboarding?: unknown }).hasCompletedOnboarding === true; } catch { return false; }
}

/**
 * #4209 — what a client needs before starting a loop on a dir: whether it
 * exists, has been through Claude's first run (a loop refuses one that has not),
 * and holds an account. Yes or no only: never what the account is.
 */
export function configDirState(c: { dir: string; json: string }): { exists: boolean; first_run_done: boolean; has_account: boolean } {
    let text: string | null = null;
    try { text = readFileSync(c.json, "utf8"); } catch { /* none yet */ }
    let account = existsSync(join(c.dir, ".credentials.json"));
    if (!account && text !== null) {
        try { account = Boolean((JSON.parse(text) as { oauthAccount?: unknown }).oauthAccount); } catch { /* unreadable */ }
    }
    return { exists: existsSync(c.dir), first_run_done: onboardingDone(text), has_account: account };
}
