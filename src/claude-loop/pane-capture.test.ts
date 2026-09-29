// #969/#1588 — pane-capture rotation. The name is `<ISO>.txt` (`:` → `-`),
// string-orderable, so sorting the names sorts them by date without a single
// `stat`.
//
// #1588: the rotation moved from a TIME window to a number of FRAMES,
// because the cache became permanent. A window in minutes kept very different
// amounts of evidence depending on whether the loop was working or sleeping;
// "the last N screens" is what someone reading the corpus wants.
// So the property that matters here is "the N most recent survive" — an
// off-by-one there silently truncates the corpus the pane detectors are tuned
// against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prunePaneCaptures } = await import("./state.js");

/** Frames named as in real life: sorted ISO = chronological order. */
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
    const dir = mkdtempSync(join(tmpdir(), "panecap-1588-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("prunePaneCaptures keeps the N MOST RECENT frames", () => {
    withDir((dir) => {
        const all = seed(dir, 10);
        prunePaneCaptures(dir, 3);
        assert.deepEqual(readdirSync(dir).sort(), all.slice(-3));
    });
});

test("prunePaneCaptures touches nothing under the limit", () => {
    withDir((dir) => {
        const all = seed(dir, 3);
        prunePaneCaptures(dir, 10);
        assert.deepEqual(readdirSync(dir).sort(), all);
    });
});

test("prunePaneCaptures : keeping exactly the present count drops nothing", () => {
    // The off-by-one: `slice(0, len - keep)` must return [] when len === keep.
    withDir((dir) => {
        const all = seed(dir, 5);
        prunePaneCaptures(dir, 5);
        assert.deepEqual(readdirSync(dir).sort(), all);
    });
});

test("prunePaneCaptures : a zero budget empties the cache", () => {
    // `pane_cache_frames: 0` means off. Leaving the old frames behind would
    // be a corpus nobody refreshes any more — worse than no corpus at all.
    withDir((dir) => {
        seed(dir, 4);
        prunePaneCaptures(dir, 0);
        assert.deepEqual(readdirSync(dir), []);
    });
});

test("prunePaneCaptures tolerates a missing dir (no throw)", () => {
    assert.doesNotThrow(() => prunePaneCaptures(join(tmpdir(), "panecap-1588-absent-xyz"), 5));
});

test("prunePaneCaptures ignores non-.txt files", () => {
    // The state dir is shared: only the `.txt` frames belong to the cache.
    withDir((dir) => {
        seed(dir, 4);
        writeFileSync(join(dir, "notes.log"), "keep");
        writeFileSync(join(dir, "README"), "keep");
        prunePaneCaptures(dir, 1);
        const left = readdirSync(dir).sort();
        assert.ok(left.includes("notes.log"));
        assert.ok(left.includes("README"));
        assert.equal(left.filter((f) => f.endsWith(".txt")).length, 1);
    });
});
