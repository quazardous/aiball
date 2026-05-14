/**
 * Git extractor: ask git for the most-recent annotated tag reachable
 * from HEAD. Falls back to listing tags matching `v*` (or the regex
 * passed via `path`) and picking the highest semver-ish one.
 *
 * No `file` required — the projectRoot is the git working tree.
 */
import { spawnSync } from "node:child_process";
import type { Component, ComponentsConfig } from "../parser.js";

export function extractGit(cfg: ComponentsConfig, comp: Component): string {
    // Try the canonical answer first.
    const desc = spawnSync(
        "git",
        ["-C", cfg.projectRoot, "describe", "--tags", "--abbrev=0"],
        { encoding: "utf8" },
    );
    if (desc.status === 0) {
        const tag = desc.stdout.trim();
        if (tag) return stripLeadingV(tag);
    }
    // Fallback: list tags matching pattern, take the lexicographically
    // last one (semver-ish since `v1.10.0` > `v1.2.0` is what we'd want
    // — naive sort is wrong, do a proper compare).
    const pattern = comp.path ?? "v*";
    const list = spawnSync(
        "git",
        ["-C", cfg.projectRoot, "tag", "--list", pattern],
        { encoding: "utf8" },
    );
    if (list.status !== 0) {
        throw new Error(
            `component '${comp.key}': git tag list failed (is ${cfg.projectRoot} a git repo?)`,
        );
    }
    const tags = list.stdout
        .split("\n")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    if (tags.length === 0) {
        throw new Error(
            `component '${comp.key}': no tags matching '${pattern}' in ${cfg.projectRoot}`,
        );
    }
    tags.sort(compareTagsSemverish);
    return stripLeadingV(tags[tags.length - 1]);
}

function stripLeadingV(tag: string): string {
    return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Lexicographically compare two tag strings as semver-ish — i.e.
 * split by `.` and compare segments numerically when both parse as
 * integers, lexicographically otherwise. Pre-release suffixes are
 * compared as strings.
 */
function compareTagsSemverish(a: string, b: string): number {
    const segs = (t: string) => stripLeadingV(t).split(/[.-]/);
    const A = segs(a);
    const B = segs(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const x = A[i] ?? "";
        const y = B[i] ?? "";
        const nx = Number(x);
        const ny = Number(y);
        if (Number.isInteger(nx) && Number.isInteger(ny)) {
            if (nx !== ny) return nx - ny;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}
