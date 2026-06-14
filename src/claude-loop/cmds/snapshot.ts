/**
 * `claude-loop snapshot [name]` — archive loop.log + pane-captures +
 * hooks logs dans un dossier datestampé sous `<sd>/snapshots/<ISO>/`
 * (#963).
 *
 * Trois modes :
 *  - capture (default) : copie les fichiers existants dans un nouveau
 *    snapshot. `--note "text"` ajoute `note.txt`.
 *  - `--list`          : liste les snapshots existants, tri desc mtime.
 *  - `--prune`         : `--keep N` (default 10), `--older Nd|h|w`,
 *    `--all` (dry-run sans `--yes`).
 *
 * Read-only sur la prod (le snapshot dir vit dans le state dir, le
 * pruning ne touche QUE `snapshots/`). Pas d'auto-prune au boot —
 * uniquement on-demand.
 */
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
    paneCaptureDir,
    stateDirFor,
    loopLogPath,
} from "../state.js";

interface SnapshotOpts {
    note?: string;
    list?: boolean;
    prune?: boolean;
    keep?: string;
    older?: string;
    all?: boolean;
    yes?: boolean;
}

function die(msg: string): never {
    process.stderr.write(`claude-loop snapshot: ${msg}\n`);
    process.exit(1);
}

function snapshotsRoot(sd: string): string {
    return join(sd, "snapshots");
}

/** Format wall-clock as `YYYY-MM-DDTHH-MM-SS` (filesystem-safe ISO). */
export function isoDirname(nowMs: number): string {
    return new Date(nowMs).toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

/** Parse `7d` / `12h` / `2w` / `30m` → milliseconds. */
export function parseTimespec(spec: string): number {
    const m = /^(\d+)([smhdw])$/.exec(spec);
    if (!m) throw new Error(`bad timespec '${spec}' — expected like '7d', '12h', '2w', '30m'`);
    const n = Number(m[1]);
    switch (m[2]) {
        case "s": return n * 1000;
        case "m": return n * 60_000;
        case "h": return n * 3_600_000;
        case "d": return n * 86_400_000;
        case "w": return n * 7 * 86_400_000;
    }
    throw new Error(`unreachable timespec unit '${m[2]}'`);
}

interface SnapshotInfo {
    name: string;
    path: string;
    mtimeMs: number;
    bytes: number;
    note: string | null;
}

/** Iterate snapshots under a state-dir, sorted desc by mtime. */
export function listSnapshots(sd: string): SnapshotInfo[] {
    const root = snapshotsRoot(sd);
    if (!existsSync(root)) return [];
    const out: SnapshotInfo[] = [];
    for (const name of readdirSync(root)) {
        const p = join(root, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        let note: string | null = null;
        const noteP = join(p, "note.txt");
        if (existsSync(noteP)) {
            try { note = readSafe(noteP).trim() || null; } catch { /* skip */ }
        }
        out.push({
            name,
            path: p,
            mtimeMs: st.mtimeMs,
            bytes: dirSize(p),
            note,
        });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
}

function readSafe(p: string): string {
    return readFileSync(p, "utf8");
}

function dirSize(dir: string): number {
    let total = 0;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            try {
                const st = statSync(p);
                if (st.isDirectory()) total += dirSize(p);
                else if (st.isFile()) total += st.size;
            } catch { /* skip */ }
        }
    } catch { /* dir gone */ }
    return total;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

/** Files at the top level of `sd` we want in every snapshot. Missing
 *  entries are silently skipped (partial state dirs survive). `timer.log`
 *  reste listé pour les state-dirs pré-#966 (avant le boot migration vers
 *  `loop.log`) — sera no-op après quelques redémarrages. */
const TOP_LEVEL_FILES = [
    "loop.log",
    "timer.log",
    "stop-hook.log",
    "session-start-hook.log",
    "afk.log",
] as const;

/** Capture a new snapshot under `<sd>/snapshots/<ISO>/`. Returns the
 *  newly-created path. */
export function captureSnapshot(sd: string, opts: { nowMs: number; note?: string }): string {
    if (!existsSync(sd)) throw new Error(`state-dir '${sd}' does not exist`);
    const root = snapshotsRoot(sd);
    mkdirSync(root, { recursive: true });
    const dirName = isoDirname(opts.nowMs);
    const target = join(root, dirName);
    if (existsSync(target)) {
        // sub-second collision — append `_2`, `_3`, … until unique.
        let n = 2;
        let alt = `${target}_${n}`;
        while (existsSync(alt)) { n++; alt = `${target}_${n}`; }
        mkdirSync(alt);
        return copyInto(sd, alt, opts.note);
    }
    mkdirSync(target);
    return copyInto(sd, target, opts.note);
}

function copyInto(sd: string, target: string, note: string | undefined): string {
    for (const f of TOP_LEVEL_FILES) {
        const src = join(sd, f);
        if (existsSync(src)) {
            try { cpSync(src, join(target, f)); } catch { /* best-effort */ }
        }
    }
    // loopLogPath() est le seul helper formel mais redondant ici (= "loop.log")
    // — la liste ci-dessus le couvre. Kept comme garde-fou conceptuel.
    void loopLogPath;
    const captures = paneCaptureDir(sd);
    if (existsSync(captures)) {
        try { cpSync(captures, join(target, "pane-captures"), { recursive: true }); } catch { /* best-effort */ }
    }
    if (note !== undefined) {
        writeFileSync(join(target, "note.txt"), `${note.trim()}\n`);
    }
    return target;
}

export function pruneSnapshots(
    sd: string,
    opts: { keep?: number; olderMs?: number; all?: boolean; nowMs: number },
): SnapshotInfo[] {
    const snaps = listSnapshots(sd);
    let victims: SnapshotInfo[] = [];
    if (opts.all) {
        victims = snaps;
    } else if (opts.olderMs !== undefined) {
        const cutoff = opts.nowMs - opts.olderMs;
        victims = snaps.filter((s) => s.mtimeMs < cutoff);
    } else {
        const keep = opts.keep ?? 10;
        victims = snaps.slice(keep); // newest `keep` survive (snaps is desc).
    }
    return victims;
}

function deleteVictims(victims: SnapshotInfo[]): void {
    for (const v of victims) {
        try { rmSync(v.path, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/** CLI entrypoint. `name` est déjà résolu par cli.ts. */
export function cmdSnapshot(name: string, opts: SnapshotOpts): void {
    const sd = stateDirFor(name);
    const nowMs = Date.now();

    if (opts.list) {
        const snaps = listSnapshots(sd);
        if (snaps.length === 0) {
            process.stdout.write("claude-loop snapshot: no snapshots yet\n");
            return;
        }
        for (const s of snaps) {
            const note = s.note ? `   (note: ${s.note})` : "";
            process.stdout.write(`${s.name}   ${formatBytes(s.bytes).padStart(7)}${note}\n`);
        }
        return;
    }

    if (opts.prune) {
        let pruneOpts: Parameters<typeof pruneSnapshots>[1];
        if (opts.all) {
            pruneOpts = { all: true, nowMs };
        } else if (opts.older) {
            try {
                pruneOpts = { olderMs: parseTimespec(opts.older), nowMs };
            } catch (e) {
                die((e as Error).message);
            }
        } else {
            const keep = opts.keep ? Number(opts.keep) : 10;
            if (!Number.isFinite(keep) || keep < 0) die(`bad --keep value '${opts.keep}'`);
            pruneOpts = { keep, nowMs };
        }
        const victims = pruneSnapshots(sd, pruneOpts);
        if (victims.length === 0) {
            process.stdout.write("claude-loop snapshot: nothing to prune\n");
            return;
        }
        // --all defaults to dry-run unless --yes; --keep/--older execute immediately.
        const dryRun = opts.all === true && opts.yes !== true;
        if (dryRun) {
            process.stdout.write(`claude-loop snapshot: would delete ${victims.length} snapshot(s) (dry-run, pass --yes to execute):\n`);
        } else {
            process.stdout.write(`claude-loop snapshot: deleting ${victims.length} snapshot(s):\n`);
        }
        for (const v of victims) {
            process.stdout.write(`  ${v.name}   ${formatBytes(v.bytes)}\n`);
        }
        if (!dryRun) deleteVictims(victims);
        return;
    }

    // Capture mode (default).
    const target = captureSnapshot(sd, { nowMs, note: opts.note });
    const captured: string[] = [];
    for (const f of TOP_LEVEL_FILES) {
        if (existsSync(join(target, f))) {
            const bytes = statSync(join(target, f)).size;
            captured.push(`  ${f.padEnd(24)} ${formatBytes(bytes).padStart(8)}`);
        }
    }
    const captureDir = join(target, "pane-captures");
    if (existsSync(captureDir)) {
        const files = readdirSync(captureDir);
        captured.push(`  ${"pane-captures/".padEnd(24)} ${`(${files.length} files)`.padStart(8)}`);
    }
    if (opts.note !== undefined) {
        captured.push(`  ${"note.txt".padEnd(24)} ${formatBytes(statSync(join(target, "note.txt")).size).padStart(8)}`);
    }
    process.stdout.write(`claude-loop: snapshot saved → ${target}\n`);
    for (const line of captured) process.stdout.write(`${line}\n`);
    if (captured.length === 0) {
        process.stdout.write("  (state dir is empty — snapshot is a no-op marker)\n");
    }
}

