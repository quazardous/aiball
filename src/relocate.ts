/**
 * `aiball relocate <old> <new>` (#2468) — move a project folder and the state
 * that is keyed by its path.
 *
 * A plain `mv` leaves behind, on the old path: Claude Code's transcripts
 * (`~/.claude/projects/<key>`), the `cwd` recorded in them, the prompt history
 * (`~/.claude/history.jsonl`, filtered by `project`), the per-project settings
 * and trust (`~/.claude.json` → `projects`), and claude-loop registrations
 * (`plate.json` → `cwd`). Symlinks and text references elsewhere point at
 * nothing. This module plans all of it (a dry run changes nothing) and applies
 * the plan.
 *
 * Claude Code's files are internal and undocumented. What is relied on was read
 * from a real install: the project key is the absolute path with every
 * non-alphanumeric character turned into `-`; transcripts carry `"cwd"`,
 * history lines carry `"project"`; `~/.claude.json` is 2-space JSON. The key is
 * lossy (`a/b` and `a-b` share one), so a transcript directory is only claimed
 * when the `cwd` inside it says it belongs to the moved folder.
 *
 * Every rewrite keeps a `.bak-relocate-<stamp>` copy and is compare-and-swap: a
 * file that changes while it is rewritten is left alone and reported.
 */
import {
    copyFileSync,
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface RelocateEnv {
    /** `~/.claude` */
    claudeDir: string;
    /** `~/.claude.json` */
    claudeJson: string;
    /** claude-loop state root (`~/.claude-loop`) */
    loopRoot: string;
    /** Roots scanned for symlinks and text references. */
    scanRoots: string[];
    /** Cwds of running processes; null when this platform cannot tell. */
    processCwds: () => Array<{ pid: number; cwd: string; cmd: string }> | null;
    /** Is this pid alive? */
    pidAlive: (pid: number) => boolean;
}

export interface RelocatePlan {
    old: string;
    new: string;
    mode: "move" | "state-only";
    /** Reasons the plan cannot be applied. Empty = applicable. */
    blockers: string[];
    /** Transcript directories to rename: from → to. */
    transcriptDirs: Array<{ from: string; to: string }>;
    /** Files to rewrite and how many path values each carries. */
    rewrites: Array<{ file: string; kind: "transcript" | "history" | "claude-json" | "plate"; count: number }>;
    /** Symlinks whose target lies under the old path. */
    links: Array<{ link: string; target: string }>;
    /** Text files under the scan roots that mention the old path (reported only). */
    references: string[];
    /** Loops registered on the old path. */
    loops: Array<{ name: string; alive: boolean }>;
    /** Process cwds could not be listed on this platform. */
    processCheckUnavailable: boolean;
}

/** Claude Code's project key for an absolute path. */
export function claudeProjectKey(absPath: string): string {
    return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

function under(path: string, root: string): boolean {
    return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite the JSON string values of `fields` that are `old` or lie under it.
 * Only those fields: a transcript quotes paths everywhere (commands, file
 * reads), and rewriting what an agent once typed would falsify the record.
 */
export function rewriteFieldPaths(text: string, fields: string[], oldPath: string, newPath: string): { text: string; count: number } {
    const re = new RegExp(`("(?:${fields.map(escapeRe).join("|")})"\\s*:\\s*")${escapeRe(oldPath)}(?=["/])`, "g");
    let count = 0;
    const out = text.replace(re, (_m, head: string) => {
        count++;
        return head + newPath;
    });
    return { text: out, count };
}

/** Rename the `projects` keys equal to `old` or under it. Returns the count. */
export function rewriteClaudeJsonProjects(json: Record<string, unknown>, oldPath: string, newPath: string): number {
    const projects = json.projects as Record<string, unknown> | undefined;
    if (!projects || typeof projects !== "object") return 0;
    let count = 0;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(projects)) {
        if (under(k, oldPath)) {
            next[newPath + k.slice(oldPath.length)] = v;
            count++;
        } else {
            next[k] = v;
        }
    }
    if (count > 0) json.projects = next;
    return count;
}

function readCwds(dir: string): Set<string> {
    const cwds = new Set<string>();
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const text = readFileSync(join(dir, f), "utf8");
        for (const m of text.matchAll(/"cwd"\s*:\s*"([^"]*)"/g)) cwds.add(m[1]);
    }
    return cwds;
}

function countFieldPaths(file: string, fields: string[], oldPath: string): number {
    return rewriteFieldPaths(readFileSync(file, "utf8"), fields, oldPath, oldPath).count;
}

function walk(root: string, visit: (path: string, isLink: boolean) => void, depth = 6): void {
    if (depth < 0 || !existsSync(root)) return;
    let entries: string[];
    try { entries = readdirSync(root); } catch { return; }
    for (const name of entries) {
        if (name === "node_modules" || name === ".git" || name === "target") continue;
        const full = join(root, name);
        let st;
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) visit(full, true);
        else if (st.isDirectory()) walk(full, visit, depth - 1);
        else if (st.isFile()) visit(full, false);
    }
}

/** Normalize the two paths the way Claude keys them: real, absolute. */
export function resolvePaths(oldArg: string, newArg: string): { old: string; new: string } {
    const real = (p: string): string => {
        const abs = resolve(p);
        if (existsSync(abs)) return realpathSync(abs);
        const parent = dirname(abs);
        return existsSync(parent) ? join(realpathSync(parent), basename(abs)) : abs;
    };
    return { old: real(oldArg), new: real(newArg) };
}

export function planRelocate(oldArg: string, newArg: string, env: RelocateEnv, opts: { stateOnly?: boolean } = {}): RelocatePlan {
    // In state-only mode the old folder is gone: keep the path as given, made
    // absolute, and resolve only its parent.
    const { old: oldPath, new: newPath } = resolvePaths(oldArg, newArg);
    const blockers: string[] = [];
    const mode = opts.stateOnly ? "state-only" : "move";

    if (oldPath === newPath) blockers.push("the old and new paths are the same");
    if (under(newPath, oldPath)) blockers.push("the new path is inside the old one");
    if (mode === "move") {
        if (!existsSync(oldPath)) blockers.push(`${oldPath} does not exist — if it was already moved, pass --state-only`);
        if (existsSync(newPath)) blockers.push(`${newPath} already exists`);
        const parent = dirname(newPath);
        if (!existsSync(parent)) blockers.push(`${parent} does not exist`);
        else if (existsSync(oldPath) && statSync(oldPath).dev !== statSync(parent).dev) {
            blockers.push("the new path is on another filesystem — move the folder yourself, then run with --state-only");
        }
    } else {
        if (existsSync(oldPath)) blockers.push(`${oldPath} still exists — --state-only is for a folder already moved`);
        if (!existsSync(newPath)) blockers.push(`${newPath} does not exist`);
    }

    // Anything still running on the old path.
    const cwds = env.processCwds();
    const processCheckUnavailable = cwds === null;
    for (const p of cwds ?? []) {
        if (under(p.cwd, oldPath)) blockers.push(`process ${p.pid} (${p.cmd}) runs in ${p.cwd}`);
        // A folder already moved may have a Claude session running in its new
        // place, writing the very history about to be renamed into.
        else if (mode === "state-only" && under(p.cwd, newPath) && /\bclaude\b/.test(p.cmd)) {
            blockers.push(`claude (process ${p.pid}) runs in ${p.cwd} — quit it first`);
        }
    }
    const loops: RelocatePlan["loops"] = [];
    const rewrites: RelocatePlan["rewrites"] = [];
    if (existsSync(env.loopRoot)) {
        for (const name of readdirSync(env.loopRoot)) {
            const plate = join(env.loopRoot, name, "plate.json");
            if (!existsSync(plate)) continue;
            let cwd: string | undefined;
            try { cwd = (JSON.parse(readFileSync(plate, "utf8")) as { cwd?: string }).cwd; } catch { continue; }
            if (!cwd || !under(cwd, oldPath)) continue;
            let alive = false;
            const pidFile = join(env.loopRoot, name, "loop.pid");
            if (existsSync(pidFile)) {
                const pid = Number(readFileSync(pidFile, "utf8").trim());
                alive = Number.isFinite(pid) && pid > 0 && env.pidAlive(pid);
            }
            loops.push({ name, alive });
            if (alive) blockers.push(`loop ${name} is running on ${cwd} — stop it first`);
            else rewrites.push({ file: plate, kind: "plate", count: countFieldPaths(plate, ["cwd", "pings_src"], oldPath) });
        }
    }

    // Claude Code transcripts: the directories whose own cwds say they belong here.
    const transcriptDirs: RelocatePlan["transcriptDirs"] = [];
    const projectsDir = join(env.claudeDir, "projects");
    const oldKey = claudeProjectKey(oldPath);
    if (existsSync(projectsDir)) {
        for (const name of readdirSync(projectsDir)) {
            if (name !== oldKey && !name.startsWith(`${oldKey}-`)) continue;
            const dir = join(projectsDir, name);
            if (!statSync(dir).isDirectory()) continue;
            // The key is lossy: `jobbox-wrap` may be `jobbox/wrap` or a sibling
            // folder named `jobbox-wrap`. The cwds recorded inside decide.
            if (![...readCwds(dir)].some((c) => under(c, oldPath))) continue;
            // The key maps character by character, so the moved prefix maps too.
            const to = join(projectsDir, claudeProjectKey(newPath) + name.slice(oldKey.length));
            if (existsSync(to)) blockers.push(`${to} already exists — Claude already has a history for the new path`);
            transcriptDirs.push({ from: dir, to });
            for (const f of readdirSync(dir)) {
                if (!f.endsWith(".jsonl")) continue;
                const count = countFieldPaths(join(dir, f), ["cwd"], oldPath);
                if (count > 0) rewrites.push({ file: join(dir, f), kind: "transcript", count });
            }
        }
    }
    // A move half done by hand: the directory already carries the new key, its
    // transcripts still record the old cwd. Rewrite in place, nothing to rename.
    const newKey = claudeProjectKey(newPath);
    if (existsSync(projectsDir)) {
        for (const name of readdirSync(projectsDir)) {
            if (name !== newKey && !name.startsWith(`${newKey}-`)) continue;
            const dir = join(projectsDir, name);
            if (!statSync(dir).isDirectory()) continue;
            for (const f of readdirSync(dir)) {
                if (!f.endsWith(".jsonl")) continue;
                const count = countFieldPaths(join(dir, f), ["cwd"], oldPath);
                if (count > 0) rewrites.push({ file: join(dir, f), kind: "transcript", count });
            }
        }
    }
    const history = join(env.claudeDir, "history.jsonl");
    if (existsSync(history)) {
        const count = countFieldPaths(history, ["project"], oldPath);
        if (count > 0) rewrites.push({ file: history, kind: "history", count });
    }
    if (existsSync(env.claudeJson)) {
        try {
            const count = rewriteClaudeJsonProjects(JSON.parse(readFileSync(env.claudeJson, "utf8")) as Record<string, unknown>, oldPath, newPath);
            if (count > 0) rewrites.push({ file: env.claudeJson, kind: "claude-json", count });
        } catch {
            blockers.push(`${env.claudeJson} is not valid JSON`);
        }
    }

    // Links and references, under the scan roots.
    const links: RelocatePlan["links"] = [];
    const references: string[] = [];
    const shortRef = `${basename(dirname(oldPath))}/${basename(oldPath)}`;
    for (const root of env.scanRoots) {
        walk(root, (path, isLink) => {
            if (under(path, oldPath) || under(path, newPath)) return;
            if (isLink) {
                const raw = readlinkSync(path);
                const target = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
                if (under(target, oldPath)) links.push({ link: path, target: raw });
                return;
            }
            let text: string;
            try {
                if (statSync(path).size > 2_000_000) return;
                text = readFileSync(path, "utf8");
            } catch { return; }
            if (text.includes(" ")) return;
            // The absolute path, or its last two segments (relative references
            // such as `../../projects/BookShepherd/jobbox`). Reported, never rewritten.
            if (text.includes(oldPath) || text.includes(shortRef)) {
                references.push(path);
            }
        });
    }

    return { old: oldPath, new: newPath, mode, blockers, transcriptDirs, rewrites, links, references, loops, processCheckUnavailable };
}

export interface ApplyResult {
    moved: boolean;
    renamed: Array<{ from: string; to: string }>;
    rewritten: Array<{ file: string; count: number; backup: string }>;
    skipped: Array<{ file: string; reason: string }>;
    relinked: Array<{ link: string; target: string }>;
}

/** Rewrite one file through `transform`, with a backup and compare-and-swap. */
function rewriteFile(file: string, transform: (text: string) => { text: string; count: number }, stamp: string): { count: number; backup: string } | { reason: string } {
    const before = statSync(file);
    const original = readFileSync(file, "utf8");
    const { text, count } = transform(original);
    if (count === 0) return { reason: "nothing to rewrite" };
    const backup = `${file}.bak-relocate-${stamp}`;
    copyFileSync(file, backup);
    const tmp = `${file}.tmp-relocate-${stamp}`;
    writeFileSync(tmp, text, { mode: before.mode & 0o777 });
    const after = statSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        unlinkSync(tmp);
        return { reason: "changed while it was being rewritten — left as is, run again" };
    }
    renameSync(tmp, file);
    return { count, backup };
}

export function applyRelocate(plan: RelocatePlan, opts: { fixLinks?: boolean; now?: Date } = {}): ApplyResult {
    if (plan.blockers.length > 0) throw new Error(`cannot relocate:\n  - ${plan.blockers.join("\n  - ")}`);
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const result: ApplyResult = { moved: false, renamed: [], rewritten: [], skipped: [], relinked: [] };

    if (plan.mode === "move") {
        renameSync(plan.old, plan.new);
        result.moved = true;
    }
    // Directories first, so the transcript rewrites below address their new home.
    const relocated = (file: string): string => {
        for (const d of plan.transcriptDirs) {
            if (file.startsWith(`${d.from}/`)) return d.to + file.slice(d.from.length);
        }
        return file;
    };
    for (const d of plan.transcriptDirs) {
        renameSync(d.from, d.to);
        result.renamed.push(d);
    }
    for (const r of plan.rewrites) {
        const file = relocated(r.file);
        const outcome = r.kind === "claude-json"
            ? rewriteFile(file, (text) => {
                const json = JSON.parse(text) as Record<string, unknown>;
                const count = rewriteClaudeJsonProjects(json, plan.old, plan.new);
                return { text: JSON.stringify(json, null, 2), count };
            }, stamp)
            : rewriteFile(file, (text) => rewriteFieldPaths(
                text,
                r.kind === "history" ? ["project"] : r.kind === "plate" ? ["cwd", "pings_src"] : ["cwd"],
                plan.old,
                plan.new,
            ), stamp);
        if ("reason" in outcome) result.skipped.push({ file, reason: outcome.reason });
        else result.rewritten.push({ file, ...outcome });
    }
    if (opts.fixLinks) {
        for (const l of plan.links) {
            const abs = isAbsolute(l.target) ? l.target : resolve(dirname(l.link), l.target);
            const target = plan.new + abs.slice(plan.old.length);
            unlinkSync(l.link);
            symlinkSync(target, l.link);
            result.relinked.push({ link: l.link, target });
        }
    }
    return result;
}
