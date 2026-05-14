/**
 * Text extractor: read the file, trim, return it whole. Useful for
 * single-line `VERSION` files.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Component, ComponentsConfig } from "../parser.js";

export function extractText(cfg: ComponentsConfig, comp: Component): string {
    if (!comp.file) {
        throw new Error(`component '${comp.key}': extractor text requires 'file'`);
    }
    const path = resolve(cfg.projectRoot, comp.file);
    return readFileSync(path, "utf8").trim();
}
