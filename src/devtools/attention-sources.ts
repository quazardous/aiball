/**
 * The traces the attention model reads (#4088), from the data aiball and Claude
 * Code already keep. Read-only throughout: the board's database is opened
 * read-only, transcripts and loop logs are only read.
 *
 * - board: what humans wrote (comments, tickets, closes) and decided
 *   (accept / reject);
 * - transcripts (`~/.claude/projects/<cwd>/*.jsonl`): the prompts typed into a
 *   Claude session, and the tokens each assistant message spent. A loop's
 *   wakes are typed into the same prompt, so they are told apart by their text;
 * - loop logs (`~/.claude-loop/<loop>/loop.log`): bursts of keys at the
 *   terminal. A log restarts with its loop, so this covers a few days at most;
 * - UI actions (`$AIBALL_HOME/ui-actions/`, #4090): the human's calls from the web
 *   board, tvty or the CLI. Only gestures count (UI_GESTURES): a UI left open
 *   calls on its own, and an open tab is not hours of work.
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
import { gunzipSync } from "node:zlib";
import type { Act, Spend } from "./attention-model.js";

/**
 * The UI calls that are a human's gesture rather than a UI refreshing itself:
 * reading a ticket, marking it read, searching, typing into a session, waking a
 * loop. A first list, to revise on a day of real lines (#4090): the log keeps
 * every call, so the list can change without losing anything.
 */
export const UI_GESTURES: ReadonlySet<string> = new Set([
    "ticket.get", "ticket.mark_read", "ticket.mark_unread", "unread.mark_read", "ping.mark_read",
    "message.search", "message.get", "mention.suggestions", "message.vote",
    "agent.pane_keys", "consumer.prompt", "loop.wake",
]);

/** A day's UI lines as acts: the gestures of humans, on a project the line or its ticket names. */
export function uiActs(day: string, text: string, humans: ReadonlySet<string>, ticketProject: ReadonlyMap<string, string>, sinceMs: number): Act[] {
    const out: Act[] = [];
    for (const line of text.split("\n")) {
        const [time, consumer, , method, project, ticket] = line.split("\t");
        if (!time || !UI_GESTURES.has(method) || !humans.has(consumer)) continue;
        const at = Date.parse(`${day}T${time}Z`);
        const where = project || ticketProject.get(ticket) || "";
        if (Number.isFinite(at) && at >= sinceMs && where) out.push({ at, project: where, kind: "ui" });
    }
    return out;
}

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
    if (dir.includes("-projects-")) return dir.split("-projects-").pop()!.replace(/^quazardous-/, "").replace(/^-+/, "") || dir;
    // Outside a projects tree (a home folder, a scratch workspace): its first
    // folder under home, which is name enough for a column.
    const underHome = /^-home-[^-]+-+(.*)$/.exec(dir)?.[1] ?? dir.replace(/^-+/, "");
    return underHome.split("-").filter(Boolean)[0] ?? dir;
}

export interface Sources {
    /** What happened. */
    acts: Act[];
    /** What would have happened with Claude sessions alone, instead. */
    counterfactual: Act[];
    /** Tickets agents filed: human traces when a human act is near (see supervisedOnly). */
    agentTickets: Act[];
    /** What each project's Claude sessions spent, for `--weight tokens`. */
    spend: Spend[];
    /** Per day, which sources had something: b(oard), c(laude transcripts), l(oop logs), u(i actions). */
    coverage: Map<string, Set<"b" | "c" | "l" | "u">>;
}

interface Options {
    sinceMs: number;
    dbPath: string;
    transcriptsDir: string;
    loopsDir: string;
    uiDir: string;
    dayOf: (ms: number) => string;
}

export function defaultOptions(sinceMs: number, dayOf: (ms: number) => string): Options {
    const home = process.env.AIBALL_HOME || join(homedir(), ".local", "share", "aiball");
    return {
        sinceMs,
        dbPath: join(home, "aiball.db"),
        transcriptsDir: join(homedir(), ".claude", "projects"),
        loopsDir: join(homedir(), ".claude-loop"),
        uiDir: join(home, "ui-actions"),
        dayOf,
    };
}

export async function collect(o: Options): Promise<Sources> {
    const acts: Act[] = [];
    const counterfactual: Act[] = [];
    const spend: Spend[] = [];
    const agentTickets: Act[] = [];
    const coverage = new Map<string, Set<"b" | "c" | "l" | "u">>();
    const cover = (ms: number, src: "b" | "c" | "l" | "u") => {
        const d = o.dayOf(ms);
        const s = coverage.get(d) ?? new Set();
        s.add(src);
        coverage.set(d, s);
    };
    const both = (a: Act) => { acts.push(a); counterfactual.push(a); };

    // --- board ------------------------------------------------------------
    const db = new Database(o.dbPath, { readonly: true, fileMustExist: true });
    const humans = new Set((db.prepare("SELECT consumer_id FROM consumers WHERE kind = 'human'").all() as { consumer_id: string }[]).map((r) => r.consumer_id));
    // Oldest seen first, so where several agents share a directory the one seen
    // last wins its transcripts (a test consumer once pointed at a real checkout).
    const agents = db.prepare("SELECT consumer_id, project, cwd FROM consumers WHERE kind != 'human' ORDER BY COALESCE(last_seen_at, '')").all() as { consumer_id: string; project: string | null; cwd: string | null }[];
    const agentProject = new Map(agents.filter((a) => a.project).map((a) => [a.consumer_id, a.project!]));
    const sinceIso = new Date(o.sinceMs).toISOString();
    type Row = { project: string; kind: string; by_agent: string; created_at: string };
    // What humans did on the board — comments, decisions (each leaves its own
    // row: plan_accepted, resolution_rejected, …), closes, relations — and
    // agents' comments on another project's tickets.
    const rows = db.prepare(`
        SELECT t.project, m.kind, m.by_agent, m.created_at
        FROM _messages m JOIN tickets t ON t.id = m.ticket_id
        WHERE m.status = 'approved' AND m.created_at >= ?`).all(sinceIso) as Row[];
    for (const r of rows) {
        const at = Date.parse(r.created_at);
        if (humans.has(r.by_agent)) {
            const kind = r.kind === "comment_added" ? "comment"
                : /_(accepted|rejected)$/.test(r.kind) ? "decision"
                : "close";
            both({ at, project: r.project, kind });
            cover(at, "b");
        } else if (r.kind === "comment_added") {
            // Claude only: an agent's word on another project's ticket is carried by hand.
            const own = agentProject.get(r.by_agent);
            if (own && own !== r.project) counterfactual.push({ at, project: r.project, kind: "relay" });
        }
    }
    // A ticket's creation is its own row, not a message.
    for (const t of db.prepare("SELECT project, by_agent, created_at FROM tickets WHERE created_at >= ?").all(sinceIso) as { project: string; by_agent: string; created_at: string }[]) {
        const at = Date.parse(t.created_at);
        if (humans.has(t.by_agent)) { both({ at, project: t.project, kind: "ticket" }); cover(at, "b"); }
        else agentTickets.push({ at, project: t.project, kind: "ticket" });
    }
    const ticketProject = new Map((db.prepare("SELECT id, project FROM tickets").all() as { id: number; project: string }[]).map((t) => [String(t.id), t.project]));
    db.close();

    // --- UI actions ---------------------------------------------------------
    if (existsSync(o.uiDir)) {
        const firstDay = new Date(o.sinceMs).toISOString().slice(0, 10);
        for (const name of readdirSync(o.uiDir)) {
            const m = /^(\d{4}-\d{2}-\d{2})\.tsv(\.gz)?$/.exec(name);
            if (!m || m[1] < firstDay) continue;
            let text = "";
            try {
                const raw = readFileSync(join(o.uiDir, name));
                text = (m[2] ? gunzipSync(raw) : raw).toString("utf8");
            } catch { continue; }
            for (const a of uiActs(m[1], text, humans, ticketProject, o.sinceMs)) {
                both(a);
                cover(a.at, "u");
            }
        }
    }

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
                    else counterfactual.push(a);
                }, (x) => spend.push(x));
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
                both({ at, project, kind: "keys" });
                cover(at, "l");
            }
        }
    }
    return { acts, counterfactual, spend, agentTickets, coverage };
}

/** Tokens one assistant message spent: new input and output; re-reading a cached context is not counted. */
export function spentTokens(usage: { input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } | undefined): number {
    if (!usage) return 0;
    return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** One transcript: its prompts (human or wake) and what each assistant message spent. */
async function readTranscript(path: string, project: string, sinceMs: number, emit: (a: Act, who: "human" | "wake") => void, spent: (s: Spend) => void): Promise<void> {
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
        const isUser = line.includes('"type":"user"');
        if (!isUser && !line.includes('"type":"assistant"')) continue;
        let j: { type?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; origin?: { kind?: string } | null; message?: { content?: unknown; usage?: Parameters<typeof spentTokens>[0] } };
        try { j = JSON.parse(line); } catch { continue; }
        const at = j.timestamp ? Date.parse(j.timestamp) : NaN;
        if (!Number.isFinite(at) || at < sinceMs) continue;
        if (j.type === "assistant") {
            // A subagent's tokens are the project's work too.
            const tokens = spentTokens(j.message?.usage);
            if (tokens > 0) spent({ at, project, tokens });
            continue;
        }
        const content = j.message?.content;
        if (j.type !== "user" || typeof content !== "string" || j.isSidechain) continue;
        const who = classifyPrompt(j, content);
        if (who) emit({ at, project, kind: "prompt" }, who);
    }
}
