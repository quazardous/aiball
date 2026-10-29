/**
 * #4120 — move a folder's Claude sessions from one Claude config dir to another,
 * for `aiball claude-config <dir> --move-sessions` and `project.settings_set`'s
 * `move_sessions` (#4419): without it, a project that switches dir starts with
 * no conversation to resume.
 *
 * What moves, for the folder only (other projects in the old dir stay):
 * - its transcripts and memory, `<dir>/projects/<key>/` (the key is the folder's
 *   path with every non-alphanumeric character a dash);
 * - its entry in `.claude.json` (`projects[folder]`: trust, allowed tools, MCP
 *   choices), removed from the old file.
 *
 * #4419 — the new dir may already hold the folder's things: a switch back to a
 * dir the folder used before, where a Claude run since left its trace. A
 * directory on both sides is merged file by file; a file on both sides keeps
 * the newer one (mtime) and the older is moved aside into
 * `<new dir>/.replaced-by-move-<date>/<key>/`, never deleted; the `.claude.json`
 * entry is merged, the moving one's keys winning and `allowedTools` joined.
 *
 * The caller refuses while a Claude runs in the folder (`claudeRunningIn`):
 * Claude writes to these.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectKey, under } from "./relocate.js";
import { relocateEnv } from "./relocate-env.js";
import type { ClaudeConfigDir } from "./claude-config-dir.js";

export interface SessionsMove {
    /** Files moved out of the old dir. */
    moved: number;
    /** Files on both sides: `path` (in the new dir) holds the newer, `aside` the older. */
    replaced: Array<{ path: string; aside: string }>;
    /** What happened to the folder's `.claude.json` entry. */
    projectEntry: "copied" | "merged" | "none";
}

/** The Claude processes running in the folder, or null when they cannot be listed here. */
export function claudeRunningIn(folder: string): Array<{ pid: number; cmd: string }> | null {
    const procs = relocateEnv([], folder).processCwds();
    if (procs === null) return null;
    return procs.filter((p) => under(p.cwd, folder) && /\bclaude\b/.test(p.cmd)).map((p) => ({ pid: p.pid, cmd: p.cmd }));
}

function moveFile(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    try {
        renameSync(from, to);
    } catch {
        // Another filesystem: copy, then remove.
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
    }
}

function readJson(file: string): Record<string, unknown> | null {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** A free path: `path`, else `path.1`, `path.2`… (two moves the same day). */
function freePath(path: string): string {
    let p = path;
    for (let n = 1; existsSync(p); n++) p = `${path}.${n}`;
    return p;
}

/** Move `src`'s entries into `dst`; `rel` is their path under the folder's key, for the aside. */
function merge(src: string, dst: string, rel: string, aside: string, out: SessionsMove): void {
    for (const name of readdirSync(src)) {
        const s = join(src, name), d = join(dst, name), r = join(rel, name);
        if (!existsSync(d)) { moveFile(s, d); out.moved++; continue; }
        const ss = lstatSync(s), ds = lstatSync(d);
        if (ss.isDirectory() && ds.isDirectory()) {
            merge(s, d, r, aside, out);
            try { rmdirSync(s); } catch { /* not empty: left as is */ }
            continue;
        }
        const away = freePath(join(aside, r));
        if (ss.mtimeMs >= ds.mtimeMs) {
            // The moving one is the newer: it takes the place, the new dir's goes aside.
            moveFile(d, away);
            moveFile(s, d);
            out.moved++;
        } else {
            moveFile(s, away);
        }
        out.replaced.push({ path: d, aside: away });
    }
}

export function moveClaudeSessions(folder: string, from: ClaudeConfigDir, to: ClaudeConfigDir, now: Date = new Date()): SessionsMove {
    const key = claudeProjectKey(folder);
    const src = join(from.dir, "projects", key);
    const dst = join(to.dir, "projects", key);
    const out: SessionsMove = { moved: 0, replaced: [], projectEntry: "none" };
    if (existsSync(src)) {
        mkdirSync(dst, { recursive: true });
        merge(src, dst, "", join(to.dir, `.replaced-by-move-${now.toISOString().slice(0, 10)}`, key), out);
        try { rmdirSync(src); } catch { /* not empty: left as is */ }
    }
    const oldJson = readJson(from.json);
    const entry = (oldJson?.projects as Record<string, unknown> | undefined)?.[folder];
    if (entry !== undefined) {
        const newJson = readJson(to.json) ?? {};
        const projects = (newJson.projects && typeof newJson.projects === "object" ? newJson.projects : {}) as Record<string, unknown>;
        const there = projects[folder];
        if (there && typeof there === "object" && entry && typeof entry === "object") {
            const a = there as Record<string, unknown>, b = entry as Record<string, unknown>;
            const merged: Record<string, unknown> = { ...a, ...b };
            if (Array.isArray(a.allowedTools) || Array.isArray(b.allowedTools)) {
                merged.allowedTools = [...new Set([...(Array.isArray(a.allowedTools) ? a.allowedTools : []), ...(Array.isArray(b.allowedTools) ? b.allowedTools : [])])];
            }
            projects[folder] = merged;
            out.projectEntry = "merged";
        } else {
            projects[folder] = entry;
            out.projectEntry = "copied";
        }
        newJson.projects = projects;
        mkdirSync(dirname(to.json), { recursive: true });
        writeFileSync(to.json, JSON.stringify(newJson, null, 2));
        delete (oldJson!.projects as Record<string, unknown>)[folder];
        writeFileSync(from.json, JSON.stringify(oldJson, null, 2));
    }
    return out;
}

/** The wire shape of a move, the same for the CLI's `--json` and the bus. */
export function sessionsWire(m: SessionsMove): { moved: number; replaced: SessionsMove["replaced"]; project_entry: SessionsMove["projectEntry"] } {
    return { moved: m.moved, replaced: m.replaced, project_entry: m.projectEntry };
}
