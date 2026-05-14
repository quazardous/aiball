/**
 * JSON extractor: read a JSON file and walk a dotted path.
 *
 *   file: package.json     path: version
 *   file: package.json     path: dependencies.react
 *
 * Path components can also be array indexes (numbers). Empty path =
 * return the whole file as a JSON-stringified value (rare, but useful
 * to inspect).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Component, ComponentsConfig } from "../parser.js";

export function extractJson(cfg: ComponentsConfig, comp: Component): string {
    if (!comp.file) {
        throw new Error(`component '${comp.key}': extractor json requires 'file'`);
    }
    const path = resolve(cfg.projectRoot, comp.file);
    const raw = readFileSync(path, "utf8");
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        throw new Error(`component '${comp.key}': ${path} is not valid JSON (${(e as Error).message})`);
    }
    if (!comp.path) return JSON.stringify(data);
    let cursor: unknown = data;
    for (const segment of comp.path.split(".")) {
        if (cursor == null || typeof cursor !== "object") {
            throw new Error(
                `component '${comp.key}': path '${comp.path}' walked past a non-object at '${segment}'`,
            );
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor === undefined || cursor === null) {
        throw new Error(`component '${comp.key}': path '${comp.path}' not found in ${path}`);
    }
    return String(cursor);
}
