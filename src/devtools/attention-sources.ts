/**
 * The traces the attention model reads (#4088), from the data aiball and Claude
 * Code already keep. Read-only throughout: the board's database is opened
 * read-only, transcripts and loop logs are only read.
 *
 * - board: what humans wrote (comments, tickets, closes) and decided
 *   (accept / reject), each with the text it answered;
 * - transcripts (`~/.claude/projects/<cwd>/*.jsonl`): the prompts typed into a
 *   Claude session and the agent output read before them. A loop's wakes are
 *   typed into the same prompt, so they are told apart by their text;
 * - loop logs (`~/.claude-loop/<loop>/loop.log`): bursts of keys at the
 *   terminal. A log restarts with its loop, so this covers a few days at most.
 *
 * The "Claude only" counterfactual is built from the same traces: each loop
 * wake would have been a prompt the human typed, and each comment an agent
 * posted on another project's ticket a message the human carried by hand.
 */
import Database from "better-sqlite3";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Act } from "./attention-model.js";

/** The text of an aiball wake, as rendered by the loop (claude-loop-pings.yaml). */
export const WAKE_RE = /look #\d+|\(#\d+ \/ #[a-z0-9]{6}\)|\(#[a-z0-9]{6}\) by |was ACCEPTED|was REJECTED|Not triaged until|another agent wrote this|tickets? closed|Signal from \S+ \(external|new ticket (\[\S+\] )?#\d+|— \d+ updates:/;

/** What a transcript's user line is: a human's prompt, a loop's wake, or neither. */
export function classifyPrompt(line: { isMeta?: boolean; isSidechain?: boolean; origin?: { kind?: string } | null }, text: string): "human" | "wake" | null {
    if (line.isMeta || line.isSidechain) return null;
    if (line.origin && line.origin.kind && line.origin.kind !== "human") return null;
    const t = text.trimStart();
    if (/^(<bash-stdout>|<bash-stderr>|<local-command-|<system-reminder>|<task-notification>|Stop hook feedback|Caveat:|<artifact-content)/.test(t)) return null;
    return WAKE_RE.test(text) ? "wake" : "human";
}

/** Claude Code's project directory name for a working directory. */
export function transcriptDirName(cwd: string): string {
    return cwd.replace(/[/.]/g, "-");
}

/** A readable project name for a transcript directory no aiball agent claims. */
export function projectFromDirName(dir: string): string {
    const after = dir.split("-projects-").pop() ?? dir;
    return after.replace(/^quazardous-/, "").replace(/^-+/, "") || dir;
}

export interface Sources {
    /** What happened. */
    acts: Act[];
    /** What would have happened with Claude sessions alone, instead. */
    counterfactual: Act[];
    /** Per day, which sources had something: b(oard), c(laude transcripts), l(oop logs). */
    coverage: Map<string, Set<"b" | "c" | "l">>;
}

interface Options {
    sinceMs: number;
    dbPath: string;
    transcriptsDir: string;
    loopsDir: string;
    dayOf: (ms: number) => string;
}

export function defaultOptions(sinceMs: number, dayOf: (ms: number) => string): Options {
    const home = process.env.AIBALL_HOME || join(homedir(), ".local", "share", "aiball");
    return {
        sinceMs,
        dbPath: join(home, "aiball.db"),
        transcriptsDir: join(homedir(), ".claude", "projects"),
        loopsDir: join(homedir(), ".claude-loop"),
        dayOf,
    };
}

export async function collect(o: Options): Promise<Sources> {
    const acts: Act[] = [];
    const counterfactual: Act[] = [];
    const coverage = new Map<string, Set<"b" | "c" | "l">>();
    const cover = (ms: number, src: "b" | "c" | "l") => {
        const d = o.dayOf(ms);
        const s = coverage.get(d) ?? new Set();
        s.add(src);
        coverage.set(d, s);
    };
    const both = (a: Act) => { acts.push(a); counterfactual.push(a); };

    // --- board ------------------------------------------------------------
    const db = new Database(o.dbPath, { readonly: true, fileMustExist: true });
    const humans = new Set((db.prepare("SELECT consumer_id FROM consumers WHERE kind = 'human'").all() as { consumer_id: string }[]).map((r) => r.consumer_id));
    const agents = db.prepare("SELECT consumer_id, project, cwd FROM consumers WHERE kind != 'human'").all() as { consumer_id: string; project: string | null; cwd: string | null }[];
    const agentProject = new Map(agents.filter((a) => a.project).map((a) => [a.consumer_id, a.project!]));
    const sinceIso = new Date(o.sinceMs).toISOString();
    type Row = { id: number; project: string; kind: string; ticket_id: number | null; by_agent: string; body: string | null; title: string | null; created_at: string; meta: string | null };
    // Every message of the tickets a human touched in the window, oldest first:
    // what came in on a ticket since the human's last word is what they read.
    const rows = db.prepare(`
        SELECT m.id, t.project, m.kind, m.ticket_id, m.by_agent,
               CASE WHEN m.kind = 'ticket_created' THEN COALESCE(t.body, m.body) ELSE m.body END AS body,
               CASE WHEN m.kind = 'ticket_created' THEN t.title END AS title,
               m.created_at, m.meta
        FROM _messages m JOIN tickets t ON t.id = m.ticket_id
        WHERE m.status = 'approved' AND m.ticket_id IN (
            SELECT DISTINCT ticket_id FROM _messages WHERE created_at >= ? AND status = 'approved'
        ) ORDER BY m.created_at`).all(sinceIso) as Row[];
    const unread = new Map<number, number>();
    for (const r of rows) {
        const ticket = r.ticket_id ?? r.id;
        const at = Date.parse(r.created_at);
        const len = (r.body?.length ?? 0) + (r.title?.length ?? 0);
        if (humans.has(r.by_agent)) {
            if (at >= o.sinceMs) {
                const kind = r.kind === "comment_added" ? "comment" : r.kind === "ticket_created" ? "ticket" : "close";
                both({ at, project: r.project, kind, readChars: unread.get(ticket) ?? 0, typeChars: kind === "close" ? 0 : len });
                cover(at, "b");
            }
            unread.set(ticket, 0);
        } else {
            unread.set(ticket, (unread.get(ticket) ?? 0) + len);
            // Claude only: an agent's word on another project's ticket is carried by hand.
            const own = agentProject.get(r.by_agent);
            if (at >= o.sinceMs && r.kind === "comment_added" && own && own !== r.project) {
                counterfactual.push({ at, project: r.project, kind: "relay", readChars: len, typeChars: 40 });
            }
        }
        // A decision is an act of its own, at the moment it was taken.
        if (r.meta && r.meta.includes('"decided_by"')) {
            try {
                const d = (JSON.parse(r.meta) as { decision?: { decided_by?: string; decided_at?: string } }).decision;
                const dAt = d?.decided_at ? Date.parse(d.decided_at) : NaN;
                if (d?.decided_by && humans.has(d.decided_by) && Number.isFinite(dAt) && dAt >= o.sinceMs) {
                    both({ at: dAt, project: r.project, kind: "decision", readChars: len, typeChars: 0 });
                    cover(dAt, "b");
                }
            } catch { /* a meta that does not parse carries no decision */ }
        }
    }
    db.close();

    // --- transcripts --------------------------------------------------------
    const dirProject = new Map(agents.filter((a) => a.cwd && a.project).map((a) => [transcriptDirName(a.cwd!), a.project!]));
    if (existsSync(o.transcriptsDir)) {
        for (const dir of readdirSync(o.transcriptsDir)) {
            const full = join(o.transcriptsDir, dir);
            const project = dirProject.get(dir) ?? projectFromDirName(dir);
            let files: string[] = [];
            try { files = readdirSync(full).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
            for (const f of files) {
                const path = join(full, f);
                if (statSync(path).mtimeMs < o.sinceMs) continue;
                await readTranscript(path, project, o.sinceMs, (a, who) => {
                    if (who === "human") { both(a); cover(a.at, "c"); }
                    else counterfactual.push({ ...a, typeChars: 80 });
                });
            }
        }
    }

    // --- loop logs ----------------------------------------------------------
    if (existsSync(o.loopsDir)) {
        for (const loop of readdirSync(o.loopsDir)) {
            const log = join(o.loopsDir, loop, "loop.log");
            const env = join(o.loopsDir, loop, "env");
            if (!existsSync(log) || !existsSync(env)) continue;
            const project = /AIBALL_PROJECT='([^']+)'/.exec(readFileSync(env, "utf8"))?.[1];
            if (!project) continue;
            const rl = createInterface({ input: createReadStream(log, "utf8"), crlfDelay: Infinity });
            for await (const line of rl) {
                if (!line.includes("proxy-event: typing")) continue;
                const ts = /"ts":"([^"]+)"/.exec(line)?.[1];
                const at = ts ? Date.parse(ts) : NaN;
                if (!Number.isFinite(at) || at < o.sinceMs) continue;
                both({ at, project, kind: "keys", readChars: 0, typeChars: 0 });
                cover(at, "l");
            }
        }
    }
    return { acts, counterfactual, coverage };
}

/** One transcript: each prompt, with the agent text that came before it. */
async function readTranscript(path: string, project: string, sinceMs: number, emit: (a: Act, who: "human" | "wake") => void): Promise<void> {
    let agentChars = 0;
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
        const isUser = line.includes('"type":"user"');
        if (!isUser && !line.includes('"type":"assistant"')) continue;
        let j: { type?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; origin?: { kind?: string } | null; message?: { content?: unknown } };
        try { j = JSON.parse(line); } catch { continue; }
        if (j.isSidechain) continue;
        const content = j.message?.content;
        if (j.type === "assistant") {
            if (Array.isArray(content)) {
                for (const c of content as { type?: string; text?: string }[]) if (c?.type === "text" && c.text) agentChars += c.text.length;
            }
            continue;
        }
        if (j.type !== "user" || typeof content !== "string") continue;
        const who = classifyPrompt(j, content);
        if (!who) continue;
        const at = j.timestamp ? Date.parse(j.timestamp) : NaN;
        if (Number.isFinite(at) && at >= sinceMs) {
            emit({ at, project, kind: "prompt", readChars: agentChars, typeChars: content.length }, who);
        }
        agentChars = 0;
    }
}

