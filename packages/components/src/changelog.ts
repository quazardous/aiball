/**
 * Tail a CHANGELOG.md by version-header. Returns the entries (most
 * recent first) up to `limit`.
 *
 * The shape we expect (Keep-a-Changelog-ish, generous):
 *
 *   ## [1.2.3] - 2026-05-12
 *   ### Added
 *   - thing
 *   ### Fixed
 *   - other
 *
 *   ## 1.2.2 - 2026-05-01
 *   ...
 *
 * Anything matching `## [vX]` or `## vX` or `## X` (where X starts
 * with a digit or `v`) starts a new entry. We don't try to be smart
 * about non-version-y headers — if your changelog has weird sections,
 * they'll be folded into the preceding entry.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentsConfig, Component } from "./parser.js";

export interface ChangelogEntry {
    header: string;
    body: string;
}

const VERSION_HEADER = /^##\s+(?:\[v?\d[^\]]*\]|v?\d\S*)(?:\s|$)/;

export function tailChangelog(
    cfg: ComponentsConfig,
    comp: Component,
    limit: number,
): ChangelogEntry[] {
    if (!comp.changelog) {
        throw new Error(`component '${comp.key}': no 'changelog' set`);
    }
    const path = resolve(cfg.projectRoot, comp.changelog);
    if (!existsSync(path)) {
        throw new Error(`component '${comp.key}': changelog file not found at ${path}`);
    }
    const lines = readFileSync(path, "utf8").split("\n");
    const entries: ChangelogEntry[] = [];
    let cur: ChangelogEntry | null = null;
    for (const line of lines) {
        if (VERSION_HEADER.test(line)) {
            if (cur) entries.push(cur);
            cur = { header: line.trim(), body: "" };
            if (entries.length >= limit) break;
            continue;
        }
        if (cur) cur.body += (cur.body ? "\n" : "") + line;
    }
    if (cur && entries.length < limit) entries.push(cur);
    return entries.map((e) => ({ header: e.header, body: e.body.trimEnd() }));
}
