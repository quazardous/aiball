/**
 * Dispatch a `Component` definition to the right extractor and
 * return the extracted version string. Throws on missing file /
 * missing path / regex mismatch — caller decides whether to swallow.
 */
import type { Component, ComponentsConfig } from "../parser.js";
import { extractJson } from "./json.js";
import { extractText } from "./text.js";
import { extractRegex } from "./regex.js";
import { extractGit } from "./git.js";

export function extractVersion(cfg: ComponentsConfig, comp: Component): string {
    switch (comp.extractor) {
        case "json":
            return extractJson(cfg, comp);
        case "text":
            return extractText(cfg, comp);
        case "regex":
            return extractRegex(cfg, comp);
        case "git":
            return extractGit(cfg, comp);
    }
}
