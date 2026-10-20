/**
 * #4120 — move a folder's Claude sessions from one Claude config dir to another,
 * for `aiball claude-config <dir> --move-sessions`: without it, a project that
 * switches dir starts with no conversation to resume.
 *
 * What moves, for the folder only (other projects in the old dir stay):
 * - its transcripts, `<dir>/projects/<key>/` (the key is the folder's path with
 *   every non-alphanumeric character a dash). Into an existing target dir, file
 *   by file; a file already there is kept and the old one left in place;
 * - its entry in `.claude.json` (`projects[folder]`: trust, allowed tools, MCP
 *   choices), copied when the new file has none, and removed from the old one.
 *
 * The caller refuses while anything runs in the folder: Claude writes to these.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectKey } from "./relocate.js";
import type { ClaudeConfigDir } from "./claude-config-dir.js";

export interface SessionsMove {
    /** Files moved out of the old transcripts dir. */
    moved: number;
    /** Files left in the old dir because the new one already had them. */
    kept: string[];
    /** Whether the folder's `.claude.json` entry went to the new file. */
    projectEntry: "copied" | "already-there" | "none";
}

function moveFile(from: string, to: string): void {
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

export function moveClaudeSessions(folder: string, from: ClaudeConfigDir, to: ClaudeConfigDir): SessionsMove {
    const key = claudeProjectKey(folder);
    const src = join(from.dir, "projects", key);
    const dst = join(to.dir, "projects", key);
    const out: SessionsMove = { moved: 0, kept: [], projectEntry: "none" };
    if (existsSync(src)) {
        mkdirSync(dst, { recursive: true });
        for (const name of readdirSync(src)) {
            if (existsSync(join(dst, name))) { out.kept.push(join(src, name)); continue; }
            moveFile(join(src, name), join(dst, name));
            out.moved++;
        }
        if (out.kept.length === 0) { try { rmdirSync(src); } catch { /* not empty: left as is */ } }
    }
    const oldJson = readJson(from.json);
    const entry = (oldJson?.projects as Record<string, unknown> | undefined)?.[folder];
    if (entry !== undefined) {
        const newJson = readJson(to.json) ?? {};
        const projects = (newJson.projects && typeof newJson.projects === "object" ? newJson.projects : {}) as Record<string, unknown>;
        if (projects[folder] === undefined) {
            projects[folder] = entry;
            newJson.projects = projects;
            mkdirSync(dirname(to.json), { recursive: true });
            writeFileSync(to.json, JSON.stringify(newJson, null, 2));
            out.projectEntry = "copied";
            delete (oldJson!.projects as Record<string, unknown>)[folder];
            writeFileSync(from.json, JSON.stringify(oldJson, null, 2));
        } else {
            out.projectEntry = "already-there";
        }
    }
    return out;
}
