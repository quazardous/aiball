// The layering rule of docs/ARCHITECTURE.md, held by a test: a client of the
// core — claude-loop, the MCP server, the simulator, autopoll — reaches the
// data only through the API (src/client.ts), never by importing the database,
// the schema, the write path or the routes. The import graph is followed
// transitively, so a shared module that pulls the database in counts too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname);

/** The core's own modules: what a client must not import, even indirectly. */
const CORE = [/^db\.ts$/, /^db\//, /^bus\//, /^schema\.ts$/, /^messages\.ts$/, /^api\.ts$/, /^api\//, /^app\.ts$/, /^daemon\.ts$/];
const isCore = (rel: string) => CORE.some((re) => re.test(rel));

/** Known crossings, named so they stay visible; each is a decision to revisit. */
const EXCEPTIONS: Record<string, string> = {
    // Minting a token is a local administration act, done on the daemon's own database.
    "cli/auth.ts": "issues and revokes tokens directly in the local database",
    // A backup copies the database file itself; it runs where the daemon's data lives.
    "cli/backup.ts": "backs up the local database",
};

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...sources(p));
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
    }
    return out;
}

/** The relative imports of a file that load code at run time, resolved to the
 *  .ts file they name. `import type` / `export type` are erased by the compiler
 *  and load nothing, so they do not count. */
function importsOf(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const m of text.matchAll(/(?:^|\n)\s*((?:import|export)\s[^;]*?)from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        if (m[1] && /^(?:import|export)\s+type\s/.test(m[1])) continue;
        const spec = m[2] ?? m[3]!;
        const base = resolve(dirname(file), spec).replace(/\.js$/, "");
        for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
            if (existsSync(cand)) { out.push(cand); break; }
        }
    }
    return out;
}

/** The first chain of imports from `start` that reaches a core module, or null. */
function pathToCore(start: string): string[] | null {
    const seen = new Set<string>([start]);
    const queue: string[][] = [[start]];
    while (queue.length) {
        const chain = queue.shift()!;
        for (const next of importsOf(chain.at(-1)!)) {
            const rel = relative(SRC, next);
            if (isCore(rel)) return [...chain, next].map((f) => relative(SRC, f));
            if (EXCEPTIONS[rel] || seen.has(next)) continue;
            seen.add(next);
            queue.push([...chain, next]);
        }
    }
    return null;
}

const CLIENTS = ["claude-loop", "mcp", "sim", "autopoll", "cli"];

for (const client of CLIENTS) {
    test(`${client}/ reaches the core only through the API`, () => {
        const leaks: string[] = [];
        for (const file of sources(join(SRC, client))) {
            if (EXCEPTIONS[relative(SRC, file)]) continue;
            const chain = pathToCore(file);
            if (chain) leaks.push(chain.join(" → "));
        }
        assert.deepEqual(leaks, [], `a client imports the core:\n  ${leaks.join("\n  ")}`);
    });
}

test("every named exception still exists (a stale one hides nothing)", () => {
    for (const rel of Object.keys(EXCEPTIONS)) assert.ok(existsSync(join(SRC, rel)), `${rel} is gone: drop its exception`);
});
