import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCwd } from "./state.js";

// #414: two aliases of the same dir (symlinked path vs target) must canonicalise
// to ONE key, else `claude-loop start` from the other alias misses a live loop
// and spawns a duplicate.
test("#414 canonicalCwd: a symlinked alias resolves to its target's realpath", () => {
    const root = mkdtempSync(join(tmpdir(), "cl-canon-"));
    try {
        const real = join(root, "real");
        const link = join(root, "link"); // link → real
        mkdirSync(real);
        symlinkSync(real, link);
        // Both the target and the symlink alias collapse to the same canonical path.
        assert.equal(canonicalCwd(link), canonicalCwd(real));
        assert.equal(canonicalCwd(link), realpathSync(real));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("#414 canonicalCwd: a child reached through a symlinked parent collapses too", () => {
    const root = mkdtempSync(join(tmpdir(), "cl-canon-"));
    try {
        const real = join(root, "real");
        const child = join(real, "proj");
        const link = join(root, "link"); // link → real
        mkdirSync(child, { recursive: true });
        symlinkSync(real, link);
        // /root/link/proj and /root/real/proj are the SAME directory.
        assert.equal(canonicalCwd(join(link, "proj")), canonicalCwd(child));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("#414 canonicalCwd: a non-existent path falls back to the raw string (no throw)", () => {
    const gone = join(tmpdir(), "cl-canon-does-not-exist-xyz");
    assert.equal(canonicalCwd(gone), gone);
});
