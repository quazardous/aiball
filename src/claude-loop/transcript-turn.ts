/**
 * #4616 — is a turn open, read from the session's transcript?
 *
 * The loop learns a turn started from the UserPromptSubmit hook, which reaches
 * it late: measured on five loops, 1.8 s at the median, 8.6 s at p90, 27 s at
 * most. Meanwhile a prompt Claude took by itself (a task notification, a queued
 * one) shows nothing on the pane, and a wake gets typed into the open turn.
 * Claude Code writes the prompt to the transcript as it takes it, so the file
 * knows first.
 *
 * #4617 — it also holds the queue: prompts waiting to be taken, greyed on the
 * screen. The hint the pane shows for them goes away while the input box holds
 * text; the file's enqueue / dequeue / remove lines do not. #4684 — only a
 * prompt holds: task notifications and agent messages also pass through the
 * queue of an idle Claude, and leave it (`remove`) without a turn; one that
 * does open a turn is held by that turn's prompt.
 *
 * #4448 — a task notification or an agent message written as a prompt opens a
 * turn only once the main thread works on it (an `api-request` of the main
 * thread, an assistant line). Claude Code also writes one right after a turn's
 * end with no turn to follow, the notification waiting for the next prompt:
 * read as a prompt, it held the loop for the whole `TRANSCRIPT_OPEN_MAX_MS`
 * (257 times in one helios session).
 *
 * Open = the last prompt has no end of turn behind it. A turn may never get one
 * (a crash, a kill), so the answer also needs the file to have grown lately:
 * past `TRANSCRIPT_OPEN_MAX_MS` of silence this proof says nothing, and what
 * shows a long tool call at work is the pane. It never holds a loop for longer.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { latestSessionFile, projectTranscriptDir } from "./token-capture.js";
import { parseSessionFile, sessionEntry, SESSION_ID_FILE } from "./session-id.js";

/** Silence after which an open turn no longer counts. Over the 27 s measured. */
export const TRANSCRIPT_OPEN_MAX_MS = 60_000;
/** A closed turn lets go at once: only the gap between two polls needs bridging. */
export const TRANSCRIPT_REMANENCE_MS = 1_500;
/** On attaching to a file, how far back to look for the current turn. */
const ATTACH_TAIL_BYTES = 256 * 1024;
/** How often the session's file is looked for again. */
const RESOLVE_EVERY_MS = 15_000;

/** What one transcript line says of the turn, or null when it says nothing. */
export type TranscriptSignal =
    | { kind: "prompt" | "end"; atMs: number }
    /** #4448 — a notification written as a prompt: a turn only if work follows. */
    | { kind: "notice"; atMs: number }
    /** #4448 — the main thread at work: an API request, an assistant line. */
    | { kind: "work"; atMs: number }
    /** `content`: the queued text, `""` when it is not text (an image, say). */
    | { kind: "queued"; atMs: number; content: string }
    | { kind: "taken"; atMs: number; op: "dequeue" | "remove"; content: string | null };

/** #4684 — what Claude Code queues on its own, which an idle Claude may drop without a turn. */
export function isNotification(content: string): boolean {
    return content.startsWith("<task-notification") || content.startsWith("<agent-message");
}

export function transcriptLineSignal(line: string): TranscriptSignal | null {
    // #4448 — the main thread at work, told by its first bytes: no parse of a long line.
    if (line.startsWith('{"type":"api-request"')) {
        return line.includes('"querySource":"repl_main_thread"') ? { kind: "work", atMs: timestampOf(line) } : null;
    }
    if (line.startsWith('{"parentUuid"') && line.includes('"type":"assistant"') && !line.includes('"isSidechain":true')) {
        return { kind: "work", atMs: timestampOf(line) };
    }
    // Cheap filter: the file is mostly tool output, parsed only when it can matter.
    if (!line.includes('"type":"user"') && !line.includes('"type":"system"') && !line.includes('"type":"queue-operation"')) return null;
    let e: {
        type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string;
        operation?: string; content?: unknown; message?: { content?: unknown };
    };
    try { e = JSON.parse(line) as typeof e; } catch { return null; }
    if (e.isSidechain) return null;
    const atMs = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (e.type === "queue-operation") {
        const content = typeof e.content === "string" ? e.content : null;
        if (e.operation === "enqueue") return { kind: "queued", atMs, content: content ?? "" };
        return e.operation === "dequeue" || e.operation === "remove" ? { kind: "taken", atMs, op: e.operation, content } : null;
    }
    if (e.type === "system") {
        return e.subtype === "stop_hook_summary" || e.subtype === "turn_duration" ? { kind: "end", atMs } : null;
    }
    if (e.type !== "user" || e.isMeta) return null;
    const c = e.message?.content;
    const first = Array.isArray(c) ? (c[0] as { type?: string; text?: string } | undefined) : undefined;
    const text = typeof c === "string" ? c : first?.type === "text" ? first.text ?? "" : null;
    if (text === null) return null; // a tool result, within a turn
    // Written with no turn to follow, or at the end of one.
    if (text.startsWith("[Request interrupted")) return { kind: "end", atMs };
    if (text.startsWith("<command-name>") || text.startsWith("<local-command")) return null;
    if (isNotification(text)) return { kind: "notice", atMs };
    return { kind: "prompt", atMs };
}

function timestampOf(line: string): number {
    const m = /"timestamp":"([^"]+)"/.exec(line);
    return m ? Date.parse(m[1]) : 0;
}

/** Polled from the pane probe: one stat, and a read only when the file grew. */
export class TranscriptTurn {
    private file: string | null = null;
    private offset = 0;
    private partial = "";
    private open = false;
    /** #4448 — a notification was written since the last end: work after it opens a turn. */
    private noticed = false;
    /** The queue in order: each entry's text. */
    private queue: string[] = [];
    private grewAtMs = 0;
    private resolvedAtMs = -Infinity;
    /** When the last turn ended, by the transcript's clock; null before one is read. */
    lastEndMs: number | null = null;

    constructor(private readonly resolve: () => string | null) {}

    /** True while a turn is open or a prompt waits, and the file is still moving. */
    poll(nowMs: number): boolean {
        try {
            if (nowMs - this.resolvedAtMs >= RESOLVE_EVERY_MS) {
                this.resolvedAtMs = nowMs;
                const file = this.resolve();
                if (file !== this.file) this.attach(file);
            }
            if (!this.file) return false;
            const st = statSync(this.file);
            if (st.size < this.offset) this.attach(this.file);
            else if (st.size > this.offset) {
                this.readFrom(this.offset, st.size);
                this.grewAtMs = st.mtimeMs;
            }
        } catch {
            // A file gone, or unreadable: this proof says nothing, the others hold.
            this.file = null;
            this.open = false;
            this.queue = [];
            return false;
        }
        const promptQueued = this.queue.some((c) => !isNotification(c));
        return (this.open || promptQueued) && nowMs - this.grewAtMs <= TRANSCRIPT_OPEN_MAX_MS;
    }

    private attach(file: string | null): void {
        this.file = file;
        this.offset = 0;
        this.partial = "";
        this.open = false;
        this.noticed = false;
        this.queue = [];
        this.lastEndMs = null;
        if (!file) return;
        const st = statSync(file);
        this.grewAtMs = st.mtimeMs;
        const from = Math.max(0, st.size - ATTACH_TAIL_BYTES);
        this.readFrom(from, st.size, from > 0);
    }

    private readFrom(from: number, to: number, skipFirstLine = false): void {
        const buf = Buffer.alloc(to - from);
        const fd = openSync(this.file!, "r");
        try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
        this.offset = to;
        const lines = (this.partial + buf.toString("utf8")).split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of skipFirstLine ? lines.slice(1) : lines) {
            const s = transcriptLineSignal(line);
            if (!s) continue;
            if (s.kind === "queued") this.queue.push(s.content);
            else if (s.kind === "taken") {
                // `dequeue` takes the head; `remove` names what it takes. An attach
                // may start past an enqueue: a removal of nothing known does nothing.
                const at = s.op === "remove" && s.content !== null ? this.queue.indexOf(s.content) : 0;
                if (at >= 0 && this.queue.length > 0) this.queue.splice(at, 1);
            }
            else if (s.kind === "notice") {
                if (!this.open) this.noticed = true;
            }
            else if (s.kind === "work") {
                if (this.noticed) this.open = true;
                this.noticed = false;
            }
            else {
                this.open = s.kind === "prompt";
                this.noticed = false;
                if (s.kind === "end") this.lastEndMs = s.atMs;
            }
        }
    }
}

/** The file of this loop's session: the id Stop recorded, or the folder's newest. */
export function sessionTranscriptFile(cwd: string, sessionKey: string): string | null {
    const dir = projectTranscriptDir(cwd);
    try {
        const id = sessionEntry(parseSessionFile(readFileSync(join(cwd, SESSION_ID_FILE), "utf8")).file, sessionKey);
        const file = id ? join(dir, `${id}.jsonl`) : null;
        if (file && existsSync(file)) return file;
    } catch { /* no id recorded yet */ }
    return latestSessionFile(dir);
}
