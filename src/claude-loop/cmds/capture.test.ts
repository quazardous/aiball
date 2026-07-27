/**
 * #1588 — what `claude-loop capture --last <n>` reads back out of the rotating
 * cache. The rotation itself is pinned in `pane-capture.test.ts`, which owns
 * `prunePaneCaptures`; this file only covers the read side.
 *
 * Run: `npx tsx --test src/claude-loop/cmds/capture.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastCachedFrames } from "./capture.js";

function seed(dir: string, count: number): string[] {
    mkdirSync(dir, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        const n = `2026-07-27T12-00-${String(i).padStart(2, "0")}.000Z.txt`;
        writeFileSync(join(dir, n), `frame ${i}\n`);
        names.push(n);
    }
    return names;
}

function withDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "capture-1588-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("--last yields the newest frames, oldest first", () => {
    // Oldest-first matters: the frames are printed in that order, and reading
    // a corpus backwards is exactly as confusing as it sounds.
    withDir((dir) => {
        const all = seed(dir, 6);
        assert.deepEqual(lastCachedFrames(dir, 2), all.slice(-2));
        assert.deepEqual(lastCachedFrames(dir, 1), all.slice(-1));
    });
});

test("asking for more frames than exist yields all of them", () => {
    withDir((dir) => {
        const all = seed(dir, 3);
        assert.deepEqual(lastCachedFrames(dir, 99), all);
    });
});

test("non-frame files are not served as frames", () => {
    withDir((dir) => {
        const all = seed(dir, 2);
        writeFileSync(join(dir, "notes.log"), "not a frame");
        assert.deepEqual(lastCachedFrames(dir, 99), all);
    });
});

test("a missing or empty cache yields nothing rather than throwing", () => {
    // The caller turns this into the "the cache is off, here is the knob"
    // message; it must not have to catch anything to get there.
    assert.deepEqual(lastCachedFrames(join(tmpdir(), "capture-1588-absent"), 5), []);
    withDir((dir) => assert.deepEqual(lastCachedFrames(dir, 5), []));
});
