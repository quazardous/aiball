/**
 * #590 — generic FILE config reader. Phase 2.
 *
 * Reads a single dotted-key value from `.aiball.yaml` (project layer) or
 * `~/.config/aiball/config.yaml` (global layer), without depending on the
 * `AiballConfig` interface or `loadConfig` parser. The schema entry coerces
 * the raw YAML value to the typed `ConfigValue`. Returns `undefined` when
 * the key is absent at that layer (the resolver can then fall through).
 *
 * Pure I/O — no in-memory cache yet (each call re-reads the YAML). Cache
 * is a phase-4 concern when the call sites multiply.
 *
 * Path resolution is intentionally duplicated from `autopoll/config.ts`
 * to avoid a cyclic import (`src/config/` shouldn't depend on
 * `src/autopoll/`). Future cleanup: consolidate in `src/config/paths.ts`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
    coerceConfigValue,
    getSchemaEntry,
    type ConfigValue,
} from "./schema.js";

const CONFIG_FILENAME = ".aiball.yaml";

function projectConfigPath(cwd: string): string | null {
    let dir = resolve(cwd);
    const rootPath = parsePath(dir).root;
    for (let i = 0; i < 64; i++) {
        const candidate = join(dir, CONFIG_FILENAME);
        if (existsSync(candidate)) return candidate;
        if (dir === rootPath) return null;
        const next = dirname(dir);
        if (next === dir) return null;
        dir = next;
    }
    return null;
}

function globalConfigPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "aiball", "config.yaml");
}

/** Walk a dotted path into a nested object. Returns `undefined` if any
 *  segment is missing or non-object before the leaf. */
function walkDotted(obj: unknown, key: string): unknown {
    if (obj == null || typeof obj !== "object") return undefined;
    let cur: unknown = obj;
    for (const seg of key.split(".")) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

const fileCache = new Map<string, { mtimeMs: number; data: unknown }>();

function readYamlCached(path: string): unknown {
    try {
        const mtime = statSync(path).mtimeMs;
        const hit = fileCache.get(path);
        if (hit && hit.mtimeMs === mtime) return hit.data;
        const data = parseYaml(readFileSync(path, "utf8")) ?? null;
        fileCache.set(path, { mtimeMs: mtime, data });
        return data;
    } catch {
        return null;
    }
}

/** #590 — read one config key from a specific FILE layer. Returns the typed
 *  value when present + valid for the schema entry, `undefined` when absent
 *  or the path doesn't resolve.
 *
 *  `cwd` matters only for the `"project"` layer (walks up for `.aiball.yaml`).
 *  The `"global"` layer ignores `cwd` and reads `~/.config/aiball/config.yaml`. */
export function readFileValue(
    layer: "project" | "global",
    key: string,
    cwd?: string,
): ConfigValue | undefined {
    const path = layer === "project"
        ? (cwd ? projectConfigPath(cwd) : null)
        : globalConfigPath();
    if (!path) return undefined;
    if (layer === "global" && !existsSync(path)) return undefined;
    const raw = readYamlCached(path);
    const value = walkDotted(raw, key);
    if (value === undefined) return undefined;
    const entry = getSchemaEntry(key);
    if (!entry) return undefined;
    const coerced = coerceConfigValue(entry, value);
    return coerced ?? undefined;
}

/** Clear the file-read cache. Mainly for tests; production reads stat the
 *  file on every call and re-parse only when mtime changes. */
export function _resetFileCache(): void {
    fileCache.clear();
}
