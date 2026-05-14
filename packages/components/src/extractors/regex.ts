/**
 * Regex extractor: read the file, apply `path` as a JS regex, return
 * the first capture group. Useful for languages that don't have a
 * structured version file (PHP, Go, ad-hoc *.h, ...).
 *
 *   file: composer.json
 *   path: "\"version\"\\s*:\\s*\"([^\"]+)\""
 *   extractor: regex
 *
 * The regex is anchored as-written (no implicit `m` / `g` flags).
 * Add them inline if needed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Component, ComponentsConfig } from "../parser.js";

export function extractRegex(cfg: ComponentsConfig, comp: Component): string {
    if (!comp.file) {
        throw new Error(`component '${comp.key}': extractor regex requires 'file'`);
    }
    if (!comp.path) {
        throw new Error(`component '${comp.key}': extractor regex requires 'path' (the regex)`);
    }
    const file = resolve(cfg.projectRoot, comp.file);
    const content = readFileSync(file, "utf8");
    let re: RegExp;
    try {
        re = new RegExp(comp.path);
    } catch (e) {
        throw new Error(`component '${comp.key}': invalid regex '${comp.path}': ${(e as Error).message}`);
    }
    const m = re.exec(content);
    if (!m) {
        throw new Error(`component '${comp.key}': regex '${comp.path}' did not match in ${file}`);
    }
    if (m[1] === undefined) {
        throw new Error(
            `component '${comp.key}': regex matched but had no capture group — add parentheses around the version`,
        );
    }
    return m[1];
}
