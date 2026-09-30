/**
 * #3299 — the text of a ticket or a comment: typed (`--body <text>`), read from
 * a file (`--body-file <path>`), or from standard input (`--body -`).
 *
 * The last two exist because an argument is not a safe place for a text of
 * several lines: on Windows the commands are `.cmd` shims, and cmd.exe cuts an
 * argument at its first line break — the ticket kept its first line, without a
 * word. A file or a pipe carries the text whole, from any shell.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BodySources {
    /** The whole of standard input, or null when nothing is piped (a terminal). */
    stdin(): string | null;
    file(path: string): string;
}

const REAL: BodySources = {
    stdin: () => (process.stdin.isTTY ? null : readFileSync(0, "utf8")),
    // A relative path is the user's, from where the command was typed: the
    // launcher has moved this process into the install root.
    file: (path) => readFileSync(resolve(process.env.AIBALL_CWD ?? process.cwd(), path), "utf8"),
};

/** What a shell adds around a piped or saved text: a byte-order mark, one final line break. */
function trimEnvelope(text: string): string {
    return text.replace(/^﻿/, "").replace(/\r?\n$/, "");
}

/**
 * The body the options name, or undefined when none does. Throws with a
 * message for the user when they contradict each other or name nothing readable.
 */
export function readBody(opts: { body?: string; bodyFile?: string }, sources: BodySources = REAL): string | undefined {
    if (opts.bodyFile !== undefined) {
        if (opts.body !== undefined) throw new Error("--body and --body-file name two texts: give one");
        try {
            return trimEnvelope(sources.file(opts.bodyFile));
        } catch (e) {
            throw new Error(`--body-file ${opts.bodyFile}: ${(e as Error).message}`);
        }
    }
    if (opts.body === "-") {
        const piped = sources.stdin();
        if (piped === null) throw new Error("--body - reads standard input, and nothing is piped in");
        return trimEnvelope(piped);
    }
    return opts.body;
}
