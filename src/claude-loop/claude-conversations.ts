/**
 * The conversations Claude Code keeps for a folder, read from its own files:
 * one `<uuid>.jsonl` transcript each, under `~/.claude/projects/<encoded cwd>`.
 * Shared by `claude-loop start` (which one to resume) and the daemon's
 * `session.conversations` (#3489: tvty offers to resume one), so both read the
 * same thing.
 *
 * Not documented by Anthropic: a line whose shape this does not know is
 * skipped, never guessed at.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isValidUuid } from "./session-id.js";

/**
 * Directory where claude stores this cwd's sessions:
 * `~/.claude/projects/<encoded-cwd>`. #620 (aiball-win) : the encoder just
 * collapses every non-alnum char to `-` (matches claude's own encoder) — on
 * Unix the leading `/` maps to `-` by the same rule, so output is identical
 * cross-platform.
 */
export function claudeProjectDir(cwd: string, home: string = homedir()): string {
    const encoded = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    return join(home, ".claude", "projects", encoded);
}

/** Whether claude has any session for `cwd`. True on an IO error (#616: the caller then lets claude decide). */
export function hasClaudeSessions(cwd: string, home?: string): boolean {
    try {
        const dir = claudeProjectDir(cwd, home);
        if (!existsSync(dir)) return false;
        return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
    } catch {
        return true;
    }
}

/**
 * #1549 — does a SPECIFIC session id already have a transcript for this cwd ?
 * False on any IO error, so a glitch degrades to "create" rather than
 * silently resuming the wrong thing.
 */
export function sessionExists(cwd: string, id: string, home?: string): boolean {
    try {
        return existsSync(join(claudeProjectDir(cwd, home), `${id}.jsonl`));
    } catch {
        return false;
    }
}

export interface Conversation {
    id: string;
    /** When its transcript was last written. */
    updated_at: string;
    /** The first thing the user typed, cut; null when none is found. */
    first_prompt: string | null;
}

const FIRST_PROMPT_MAX = 120;
const HEAD_BYTES = 256 * 1024;

/**
 * The first message the user typed in a transcript, from its head only: a
 * plain-text user line that is neither meta (`isMeta`) nor a slash command or
 * its output (`<command-…>`, `<local-command-…>`). Cut to 120 characters.
 */
export function firstPrompt(file: string): string | null {
    let text: string;
    try {
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(Math.min(HEAD_BYTES, statSync(file).size));
            readSync(fd, buf, 0, buf.length, 0);
            text = buf.toString("utf8");
        } finally { closeSync(fd); }
    } catch { return null; }
    for (const line of text.split("\n")) {
        if (!line.includes('"user"')) continue;
        let o: { type?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } };
        try { o = JSON.parse(line); } catch { continue; } // the last line of a head may be cut
        if (o.type !== "user" || o.isMeta === true || o.message?.role !== "user") continue;
        const c = o.message.content;
        const said = typeof c === "string" ? c
            : Array.isArray(c) ? (c as Array<{ type?: unknown; text?: unknown }>).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join(" ")
            : "";
        const s = said.replace(/\s+/g, " ").trim();
        if (!s || s.startsWith("<") || s.startsWith("Caveat:")) continue;
        return s.length > FIRST_PROMPT_MAX ? `${s.slice(0, FIRST_PROMPT_MAX - 1)}…` : s;
    }
    return null;
}

/** The folder's conversations, most recently written first, at most `limit`. */
export function listConversations(cwd: string, limit = 20, home?: string): Conversation[] {
    const dir = claudeProjectDir(cwd, home);
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const found: Array<{ id: string; file: string; mtime: number }> = [];
    for (const f of names) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -".jsonl".length);
        if (!isValidUuid(id)) continue;
        const file = join(dir, f);
        try { found.push({ id: id.toLowerCase(), file, mtime: statSync(file).mtimeMs }); } catch { /* gone meanwhile */ }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, Math.max(0, limit)).map((c) => ({ id: c.id, updated_at: new Date(c.mtime).toISOString(), first_prompt: firstPrompt(c.file) }));
}

/** The folder's most recently written conversation, or null. */
export function latestConversation(cwd: string, home?: string): string | null {
    return listConversations(cwd, 1, home)[0]?.id ?? null;
}

/**
 * #3489 — what `--resume-session` (`session.start`'s `resume`) names: `latest`
 * or a conversation id, checked against the folder. An error says why not.
 */
export function pickConversation(cwd: string, pick: string, home?: string): { id: string } | { error: string } {
    if (pick === "latest") {
        const id = latestConversation(cwd, home);
        return id ? { id } : { error: `Claude Code has no conversation in ${cwd} to resume` };
    }
    if (!isValidUuid(pick)) return { error: `not a conversation id: ${pick} (a uuid, or latest)` };
    const id = pick.toLowerCase();
    return sessionExists(cwd, id, home) ? { id } : { error: `no conversation ${id} in ${cwd}` };
}
