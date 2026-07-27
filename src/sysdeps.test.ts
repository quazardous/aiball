/**
 * #1571 — the per-platform prerequisite lists.
 *
 * These assert the LIST, not the probing: `checkPrereqs` is host-bound by
 * nature (it looks at the real PATH), but which prerequisites a platform
 * declares is a pure fact and must be assertable from either lane. Without
 * `prereqsFor`, a mistake in the Windows list could only ever be caught by the
 * Windows runner — the one lane we least want to rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prereqsFor } from "./sysdeps.js";

const names = (p: NodeJS.Platform) => prereqsFor(p).map((x) => x.cmd);

test("Windows declares its own runtime, not the POSIX one", () => {
    const win = names("win32");
    assert.deepEqual(win, ["psmux", "bash", "cargo"]);
    // There is no Python proxy on Windows, so listing python3 would name a
    // degradation that cannot happen.
    assert.ok(!win.includes("python3"));
    // tmux is the POSIX multiplexer; on Windows it only exists as psmux's alias.
    assert.ok(!win.includes("tmux"));
});

test("psmux accepts its tmux alias, which is why the default MUX_CMD resolves", () => {
    const psmux = prereqsFor("win32").find((p) => p.cmd === "psmux");
    assert.ok(psmux, "psmux must be declared on win32");
    assert.deepEqual([...(psmux.altCmds ?? [])], ["tmux"]);
});

test("bash is required on Windows — claude-loop spawns `bash -lc` on every start", () => {
    const bash = prereqsFor("win32").find((p) => p.cmd === "bash");
    assert.ok(bash, "bash must be declared on win32");
    assert.equal(bash.required, true);
});

test("every Windows prerequisite names a winget package, or the miss has no fix", () => {
    // A named miss without an install command is what the POSIX list produced
    // on Windows: no manager matched, so `install` stayed null.
    for (const p of prereqsFor("win32")) {
        assert.ok(p.packages?.winget, `${p.cmd} has no winget package`);
    }
});

test("POSIX keeps its own list, unchanged by the split", () => {
    assert.deepEqual(names("linux"), ["tmux", "python3", "cargo"]);
    assert.deepEqual(names("darwin"), ["tmux", "python3", "cargo"]);
});

test("a required prerequisite states what breaks; an optional one states what degrades", () => {
    for (const platform of ["win32", "linux"] as const) {
        for (const p of prereqsFor(platform)) {
            assert.ok(p.powers.length > 0, `${platform}/${p.cmd}: empty powers`);
            if (!p.required) {
                assert.ok(p.degraded.length > 0, `${platform}/${p.cmd}: optional but no degraded mode named`);
            }
        }
    }
});
