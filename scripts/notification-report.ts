/**
 * Task notifications in Claude's sessions, per folder and per day (#4434): how
 * many reach the main session, how many repeat one already sent for the same
 * task, how many say an agent is "waiting on its own background work", and how
 * many open a turn (the main thread works on it) rather than wait for the next
 * prompt. A report: it reads the transcripts, it writes nothing. Run it again
 * after each Claude Code update: the repeats are Claude Code's, and change with
 * its version.
 *
 *     npx tsx scripts/notification-report.ts [--since 7d] [--project helios[,mcu]] [--json]
 *
 * --since    how far back: Nd (days) or a date (default 7d)
 * --project  only the folders whose name ends with one of these (comma-separated)
 * --json     every row, as JSON
 *
 * It reads ~/.claude*\/projects/*\/*.jsonl, every config dir of this user.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface Row {
    folder: string;
    day: string;
    versions: Set<string>;
    notifications: number;
    tasks: Set<string>;
    waiting: number;
    openedTurn: number;
}

interface Pending { row: Row; atMs: number }

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function sinceMs(v: string | undefined): number {
    const days = /^(\d+)d$/.exec(v ?? "7d");
    if (days) return Date.now() - Number(days[1]) * 86_400_000;
    const at = Date.parse(v!);
    if (Number.isNaN(at)) throw new Error(`--since: ${v} is neither Nd nor a date`);
    return at;
}

/** The folder a Claude `projects/` entry stands for, shortened to its last part. */
function folderOf(entry: string): string {
    return entry.split("-").filter(Boolean).slice(-2).join("-");
}

function transcripts(since: number, projects: string[] | null): Array<{ folder: string; file: string }> {
    const out: Array<{ folder: string; file: string }> = [];
    for (const dir of readdirSync(homedir())) {
        if (!dir.startsWith(".claude")) continue;
        const root = join(homedir(), dir, "projects");
        let entries: string[];
        try { entries = readdirSync(root); } catch { continue; }
        for (const entry of entries) {
            const folder = folderOf(entry);
            if (projects && !projects.some((p) => entry.endsWith(p))) continue;
            let files: string[];
            try { files = readdirSync(join(root, entry)); } catch { continue; }
            for (const f of files) {
                if (!f.endsWith(".jsonl")) continue;
                const file = join(root, entry, f);
                if (statSync(file).mtimeMs >= since) out.push({ folder, file });
            }
        }
    }
    return out;
}

function textOf(content: unknown): string | null {
    if (typeof content === "string") return content;
    const first = Array.isArray(content) ? (content[0] as { type?: string; text?: string } | undefined) : undefined;
    return first?.type === "text" ? first.text ?? "" : null;
}

async function read(folder: string, file: string, since: number, rows: Map<string, Row>): Promise<void> {
    let pending: Pending | null = null;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
        // The main thread at work: a notification just seen opened a turn.
        if (pending && (line.startsWith('{"type":"api-request"') ? line.includes('"querySource":"repl_main_thread"')
            : line.includes('"type":"assistant"') && !line.includes('"isSidechain":true'))) {
            pending.row.openedTurn++;
            pending = null;
            continue;
        }
        if (!line.includes('"type":"user"') && !line.includes('"subtype":"turn_duration"') && !line.includes('"subtype":"stop_hook_summary"')) continue;
        let e: { type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; version?: string; message?: { content?: unknown } };
        try { e = JSON.parse(line) as typeof e; } catch { continue; }
        if (e.isSidechain || !e.timestamp) continue;
        if (e.type === "system") { pending = null; continue; }
        if (e.type !== "user" || e.isMeta) continue;
        const text = textOf(e.message?.content);
        if (text === null) continue;
        pending = null;
        if (!text.startsWith("<task-notification")) continue;
        const atMs = Date.parse(e.timestamp);
        if (atMs < since) continue;
        const day = e.timestamp.slice(0, 10);
        const key = `${folder}\0${day}`;
        let row = rows.get(key);
        if (!row) rows.set(key, row = { folder, day, versions: new Set(), notifications: 0, tasks: new Set(), waiting: 0, openedTurn: 0 });
        row.notifications++;
        if (e.version) row.versions.add(e.version);
        const task = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
        if (task) row.tasks.add(task);
        if (/waiting on its own background work/.test(text)) row.waiting++;
        pending = { row, atMs };
    }
}

const since = sinceMs(arg("--since"));
const projects = arg("--project")?.split(",").filter(Boolean) ?? null;
const rows = new Map<string, Row>();
for (const { folder, file } of transcripts(since, projects)) await read(folder, file, since, rows);
const sorted = [...rows.values()].sort((a, b) => a.folder.localeCompare(b.folder) || a.day.localeCompare(b.day));

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(sorted.map((r) => ({
        folder: r.folder, day: r.day, versions: [...r.versions].sort(), notifications: r.notifications,
        tasks: r.tasks.size, repeats: r.notifications - r.tasks.size, waiting: r.waiting, opened_turn: r.openedTurn,
    })), null, 2));
} else {
    const head = ["folder", "day", "notif", "tasks", "repeats", "waiting", "turns", "claude"];
    const table = sorted.map((r) => [r.folder, r.day, r.notifications, r.tasks.size, r.notifications - r.tasks.size, r.waiting, r.openedTurn, [...r.versions].sort().join(" ")].map(String));
    const width = head.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
    const fmt = (cells: string[]) => cells.map((c, i) => (i < 2 || i === 7 ? c.padEnd(width[i]) : c.padStart(width[i]))).join("  ");
    console.log(fmt(head));
    for (const t of table) console.log(fmt(t));
    console.log("\nnotif: task notifications in the main session · tasks: distinct task ids · repeats: notif - tasks");
    console.log("waiting: \"waiting on its own background work\" · turns: notifications the main thread worked on");
}
