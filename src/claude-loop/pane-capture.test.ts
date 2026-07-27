// #969/#1588 — rotation des pane-captures. Le nom est `<ISO>.txt` (`:` → `-`),
// string-orderable, donc trier les noms les trie par date sans un seul `stat`.
//
// #1588 : la rotation est passée d'une fenêtre en TEMPS à un nombre de FRAMES,
// parce que le cache est devenu permanent. Une fenêtre en minutes gardait des
// quantités de preuve très différentes selon que la loop bossait ou dormait ;
// « les N derniers écrans » est ce que veut quelqu'un qui lit le corpus.
// La propriété qui compte ici est donc « les N plus récents survivent » — un
// off-by-one y tronque en silence le corpus contre lequel on règle les
// détecteurs de pane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prunePaneCaptures } = await import("./state.js");

/** Frames nommées comme en vrai : ISO trié = ordre chronologique. */
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

test("prunePaneCaptures garde les N frames les PLUS RÉCENTES", () => {
    withDir((dir) => {
        const all = seed(dir, 10);
        prunePaneCaptures(dir, 3);
        assert.deepEqual(readdirSync(dir).sort(), all.slice(-3));
    });
});

test("prunePaneCaptures ne touche à rien sous la limite", () => {
    withDir((dir) => {
        const all = seed(dir, 3);
        prunePaneCaptures(dir, 10);
        assert.deepEqual(readdirSync(dir).sort(), all);
    });
});

test("prunePaneCaptures : garder exactement le nombre présent ne drop rien", () => {
    // L'off-by-one : `slice(0, len - keep)` doit rendre [] quand len === keep.
    withDir((dir) => {
        const all = seed(dir, 5);
        prunePaneCaptures(dir, 5);
        assert.deepEqual(readdirSync(dir).sort(), all);
    });
});

test("prunePaneCaptures : un budget nul vide le cache", () => {
    // `pane_cache_frames: 0` veut dire éteint. Laisser les vieilles frames
    // derrière, ce serait un corpus que plus personne ne rafraîchit — pire
    // que pas de corpus du tout.
    withDir((dir) => {
        seed(dir, 4);
        prunePaneCaptures(dir, 0);
        assert.deepEqual(readdirSync(dir), []);
    });
});

test("prunePaneCaptures tolère un dir absent (no throw)", () => {
    assert.doesNotThrow(() => prunePaneCaptures(join(tmpdir(), "panecap-1588-absent-xyz"), 5));
});

test("prunePaneCaptures ignore les fichiers non-.txt", () => {
    // Le state dir est partagé : seules les frames `.txt` appartiennent au cache.
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
