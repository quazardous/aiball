/**
 * #3299 — a ticket's or a comment's text from a file or from standard input:
 * an argument of several lines is cut at its first line break by a Windows
 * `.cmd` shim, a file or a pipe carries it whole.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { readBody, type BodySources } from "./body-arg.js";

// Loaded before any test is declared: a test declared after an `await` would start
// once the `after` hook below has already removed the folder.
process.env.AIBALL_SOCK = "";
const { AiballClient } = await import("../client.js");
const { registerTicketCommands } = await import("./ticket.js");

const dir = mkdtempSync(join(tmpdir(), "aiball-3299-body-"));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file */ } });

const sources = (stdin: string | null, files: Record<string, string> = {}): BodySources => ({
    stdin: () => stdin,
    file: (p) => {
        if (!(p in files)) throw new Error("no such file");
        return files[p];
    },
});

test("typed, it is the text as it is; absent, there is none", () => {
    assert.equal(readBody({ body: "one line" }, sources(null)), "one line");
    assert.equal(readBody({}, sources(null)), undefined);
});

test("--body - is the whole of standard input, without what the shell wrapped it in", () => {
    assert.equal(readBody({ body: "-" }, sources("line 1\nline 2\nline 3\n")), "line 1\nline 2\nline 3");
    assert.equal(readBody({ body: "-" }, sources("﻿line 1\r\nline 2\r\n")), "line 1\r\nline 2", "a BOM and one final CRLF go; the text's own line breaks stay");
    assert.equal(readBody({ body: "-" }, sources("a\n\n")), "a\n", "only one final line break is the shell's");
    assert.throws(() => readBody({ body: "-" }, sources(null)), /nothing is piped in/);
});

test("--body-file is the file's text; with --body too, or unreadable, it says so", () => {
    assert.equal(readBody({ bodyFile: "note.md" }, sources(null, { "note.md": "# title\n\nbody\n" })), "# title\n\nbody");
    assert.throws(() => readBody({ body: "x", bodyFile: "note.md" }, sources(null, { "note.md": "y" })), /two texts/);
    assert.throws(() => readBody({ bodyFile: "gone.md" }, sources(null)), /--body-file gone\.md: no such file/);
});

// ---- the commands themselves ----

const posted: Record<string, unknown>[] = [];
(AiballClient.prototype as unknown as { postMessage: (b: Record<string, unknown>) => Promise<unknown> }).postMessage = async (b) => {
    posted.push(b);
    return { id: 1, kind: b.kind, status: "approved" };
};

async function run(...args: string[]): Promise<Record<string, unknown>> {
    const program = new Command().exitOverride().option("--json").option("--human");
    registerTicketCommands(program);
    const log = console.log;
    console.log = () => {};
    try {
        await program.parseAsync(["node", "aiball", "ticket", ...args]);
    } finally {
        console.log = log;
    }
    return posted.at(-1)!;
}

test("ticket new and ticket comment post a file's text whole, a relative path read from the typed folder", async () => {
    writeFileSync(join(dir, "note.md"), "line 1\nline 2\nline 3\n");
    const before = process.env.AIBALL_CWD;
    process.env.AIBALL_CWD = dir;
    try {
        const created = await run("new", "--title", "t", "--project", "p", "--by", "worker", "--body-file", "note.md");
        assert.equal(created.body, "line 1\nline 2\nline 3");
        const comment = await run("comment", "--id", "7", "--by", "worker", "--commits", "none", "--handback", "--summary", "s", "--body-file", join(dir, "note.md"));
        assert.equal(comment.body, "line 1\nline 2\nline 3");
    } finally {
        if (before === undefined) delete process.env.AIBALL_CWD; else process.env.AIBALL_CWD = before;
    }
});

test("a typed --body still goes out as it is", async () => {
    const comment = await run("comment", "--id", "7", "--by", "worker", "--commits", "none", "--handback", "--summary", "s", "--body", "done");
    assert.equal(comment.body, "done");
});
