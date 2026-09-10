/**
 * #2193 — the bilingual search dictionary, and nothing else.
 *
 * A LEAF module: it reads a YAML file and folds strings. No database, no HTTP.
 * That is what lets the MCP server import it to render the expansion in its
 * result header without opening a SQLite connection it has no business
 * holding — the MCP process talks to the daemon over HTTP, never to the file.
 *
 * Same shape as `flags-cache.ts` and `inbox-agg-cache.ts`: when two layers
 * need one rule, the rule moves down rather than being written twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { installRoot } from "./claude-loop/state.js";

/** Lowercase + strip combining marks, so `reveil` matches a group listing
 *  `réveil`. Mirrors what the trigram tokenizer already does with accents. */
export function foldTerm(s: string): string {
    return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

let groups: string[][] | null = null;

function loadGroups(): string[][] {
    if (groups) return groups;
    try {
        const path = join(installRoot(), "config", "search-synonyms.yaml");
        const doc = parseYaml(readFileSync(path, "utf8")) as { groups?: unknown };
        groups = Array.isArray(doc?.groups)
            ? doc.groups.filter((g): g is string[] =>
                Array.isArray(g) && g.length > 1
                && g.every((t) => typeof t === "string" && t.length > 0))
            : [];
    } catch {
        // Missing or malformed: expansion is simply OFF. A search that stops
        // widening behaves like it did last week; one that throws takes the
        // whole feature down for a config typo.
        groups = [];
    }
    return groups;
}

/** Tests — reload after writing a fixture. */
export function resetSynonymsForTests(): void {
    groups = null;
}

/**
 * Expand one token to its group, the caller's spelling first.
 *
 * A token in no group comes back alone, so the common case costs nothing and
 * behaves exactly as before.
 */
export function expandToken(token: string): string[] {
    const key = foldTerm(token);
    for (const g of loadGroups()) {
        if (g.some((t) => foldTerm(t) === key)) {
            return [token, ...g.filter((t) => foldTerm(t) !== key)];
        }
    }
    return [token];
}
