/**
 * #3299 — whether a loop's timer is listening is `transport.reachable(sock)`,
 * never `existsSync(sock)`. win32 publishes `<sock>.addr` and no socket file,
 * so a file check answers "down" on every Windows loop: hook events went to the
 * offload buffer instead of the kernel, raw-byte injection and the reload
 * snapshot handover gave up. `inspect` and `health` had the same bug (#1181).
 * This scan keeps the next caller from reaching for the Unix-shaped question.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === "transport" ? [] : sources(p);
        return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
}

test("no loop.sock pre-flight asks the filesystem", () => {
    const hits = sources(ROOT).flatMap((f) =>
        readFileSync(f, "utf8").split("\n")
            .map((line, i) => ({ line, at: `${relative(ROOT, f)}:${i + 1}` }))
            .filter(({ line }) => /existsSync\(\s*(sock|sockPath|loopSockPath\()/.test(line))
            .map(({ at, line }) => `${at}  ${line.trim()}`));
    assert.deepEqual(hits, [], "use selectTransport().reachable(sock) instead");
});
