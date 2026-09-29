/**
 * #3299 — `bin/claude-loop` and `bin/aiball` are `#!/usr/bin/env node` scripts
 * with no extension. Linux runs the shebang; Windows cannot execute them and
 * `spawn` fails with ENOENT — which, without an 'error' listener, took the
 * daemon down (session.start). They are launched as `node <script>`
 * (process.execPath) everywhere, and this scan keeps it that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = import.meta.dirname;
// Native binaries, not shebang scripts: the session host (Unix-only for now) and
// the PTY proxy, whose `--version` the machine check reads.
const SKIP = new Set([join("sessions", "hosts.ts"), "machine-check.ts"]);

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return sources(p);
        return p.endsWith(".ts") && !p.endsWith(".test.ts") && !SKIP.has(relative(SRC, p)) ? [p] : [];
    });
}

test("the node launchers in bin/ are never spawned as executables", () => {
    const direct = /spawn(Sync|Detached)?\(\s*(CLAUDE_LOOP_BIN|bin|join\(installRoot\(\), "bin", "(claude-loop|aiball)"\))\s*,/;
    const hits = sources(SRC).flatMap((f) =>
        readFileSync(f, "utf8").split("\n")
            .map((line, i) => ({ line, at: `${relative(SRC, f)}:${i + 1}` }))
            .filter(({ line }) => direct.test(line))
            .map(({ at, line }) => `${at}  ${line.trim()}`));
    assert.deepEqual(hits, [], "spawn(process.execPath, [script, ...args]) instead");
});
