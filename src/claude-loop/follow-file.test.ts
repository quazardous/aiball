/**
 * #3299 — `followLines`, the `tail -n N -F` of `claude-loop tail` / `log`:
 * the last lines, then the new ones; a file waited for; a file truncated,
 * replaced, or written in pieces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLines } from "./follow-file.js";

const TICK = 20;
const settle = () => new Promise((r) => setTimeout(r, TICK * 4));

function scratch(): { dir: string; path: string; done(): void } {
    const dir = mkdtempSync(join(tmpdir(), "follow-3299-"));
    return { dir, path: join(dir, "loop.log"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the last lines first, then each new one", async () => {
    const s = scratch();
    writeFileSync(s.path, "a\nb\nc\n");
    const got: string[] = [];
    const h = followLines(s.path, 2, (l) => got.push(l), { intervalMs: TICK });
    try {
        assert.deepEqual(got, ["b", "c"]);
        appendFileSync(s.path, "d\ne\n");
        await settle();
        assert.deepEqual(got, ["b", "c", "d", "e"]);
    } finally { h.stop(); s.done(); }
});

test("a line written in two pieces comes out once, whole", async () => {
    const s = scratch();
    writeFileSync(s.path, "");
    const got: string[] = [];
    const h = followLines(s.path, 10, (l) => got.push(l), { intervalMs: TICK });
    try {
        appendFileSync(s.path, "hal");
        await settle();
        assert.deepEqual(got, []);
        appendFileSync(s.path, "f\r\nnext\n");
        await settle();
        assert.deepEqual(got, ["half", "next"], "a CRLF line loses its \\r");
    } finally { h.stop(); s.done(); }
});

test("a file that does not exist yet is waited for, and read whole", async () => {
    const s = scratch();
    const got: string[] = [];
    const h = followLines(s.path, 1, (l) => got.push(l), { intervalMs: TICK });
    try {
        await settle();
        writeFileSync(s.path, "one\ntwo\n");
        await settle();
        assert.deepEqual(got, ["one", "two"]);
    } finally { h.stop(); s.done(); }
});

test("a truncated or replaced file is read again from its start", async () => {
    const s = scratch();
    writeFileSync(s.path, "old 1\nold 2\n");
    const got: string[] = [];
    const h = followLines(s.path, 0, (l) => got.push(l), { intervalMs: TICK });
    try {
        writeFileSync(s.path, "new\n");
        await settle();
        assert.deepEqual(got, ["new"], "truncated");
        const other = join(s.dir, "rotated");
        writeFileSync(other, "rotated 1\nrotated 2\nrotated 3\n");
        renameSync(other, s.path);
        await settle();
        assert.deepEqual(got, ["new", "rotated 1", "rotated 2", "rotated 3"], "replaced");
    } finally { h.stop(); s.done(); }
});

test("a multi-byte character split across two writes is not garbled", async () => {
    const s = scratch();
    writeFileSync(s.path, "");
    const got: string[] = [];
    const h = followLines(s.path, 10, (l) => got.push(l), { intervalMs: TICK });
    try {
        const bytes = Buffer.from("café\n", "utf8");
        appendFileSync(s.path, bytes.subarray(0, 4));
        await settle();
        appendFileSync(s.path, bytes.subarray(4));
        await settle();
        assert.deepEqual(got, ["café"]);
    } finally { h.stop(); s.done(); }
});
