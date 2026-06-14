// #969 — rotation des pane-captures : `prunePaneCaptures` supprime les
// frames dont le nom ISO est < cutoff. Le nom est `<ISO>.txt` (`:` → `-`),
// string-orderable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prunePaneCaptures } = await import("./state.js");

function isoName(ms: number): string {
    return new Date(ms).toISOString().replace(/:/g, "-") + ".txt";
}

test("prunePaneCaptures garde les fichiers >= cutoff et drop les < cutoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "panecap-969-"));
    const nowMs = Date.UTC(2026, 5, 14, 12, 0, 0);
    const cutoff = nowMs - 5 * 60_000; // 5 minutes ago
    // 5 frames before cutoff (should drop)
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, isoName(cutoff - (i + 1) * 1000)), "old");
    // 3 frames after cutoff (should keep)
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, isoName(cutoff + (i + 1) * 1000)), "new");
    prunePaneCaptures(dir, cutoff);
    const left = readdirSync(dir);
    assert.equal(left.length, 3, `expected 3 frames left, got ${left.length}`);
    for (const f of left) assert.ok(f >= isoName(cutoff), `${f} should be >= cutoff`);
    rmSync(dir, { recursive: true, force: true });
});

test("prunePaneCaptures tolère un dir absent (no throw)", () => {
    assert.doesNotThrow(() => prunePaneCaptures("/tmp/panecap-969-does-not-exist-xyz", Date.now()));
});

test("prunePaneCaptures ignore les fichiers non-.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "panecap-969b-"));
    const cutoff = Date.now();
    const oldIso = new Date(cutoff - 10_000).toISOString().replace(/:/g, "-");
    writeFileSync(join(dir, `${oldIso}.txt`), "drop");
    writeFileSync(join(dir, `${oldIso}.log`), "keep"); // wrong ext
    writeFileSync(join(dir, "README"), "keep");        // no ext
    prunePaneCaptures(dir, cutoff);
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, [`${oldIso}.log`, "README"]);
    rmSync(dir, { recursive: true, force: true });
});
