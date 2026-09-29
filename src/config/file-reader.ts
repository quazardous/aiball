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
 * #3250 — the one place config paths are resolved and config files read
 * (cached on mtime): `autopoll/config.ts`, the daemon and the inbox import
 * them from here.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
    coerceConfigValue,
    getSchemaEntry,
    RENAMED_CONFIG_KEYS,
    type ConfigValue,
} from "./schema.js";

export const CONFIG_FILENAME = ".aiball.yaml";

export function projectConfigPath(cwd: string): string | null {
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

/** The user's global config (`$XDG_CONFIG_HOME` or `~/.config`, then `aiball/config.yaml`). */
export function globalConfigPath(): string {
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

/** A config file's content, parsed and cached on its mtime; null when absent or unreadable. */
export function readConfigFile(path: string): unknown {
    return readYamlCached(path);
}

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
    const entry = getSchemaEntry(key);
    if (!entry) return undefined;
    const value = walkDotted(raw, key);
    if (value !== undefined) return coerceConfigValue(entry, value) ?? undefined;
    // #3138 — the name it had before, for one version: its value converted.
    for (const [old, r] of Object.entries(RENAMED_CONFIG_KEYS)) {
        if (r.key !== key) continue;
        const legacy = walkDotted(raw, old);
        if (typeof legacy === "number") return coerceConfigValue(entry, Math.round(legacy * r.factor)) ?? undefined;
        if (legacy !== undefined) return coerceConfigValue(entry, legacy) ?? undefined;
    }
    return undefined;
}

/** Clear the file-read cache. Mainly for tests; production reads stat the
 *  file on every call and re-parse only when mtime changes. */
export function _resetFileCache(): void {
    fileCache.clear();
}

/**
 * #3250 — a key of the global config through its schema entry: typed, its
 * rename honoured, else the entry's default. Values outside the entry's range
 * fall back to the default too, as a refused `config.set` would.
 */
export function globalConfigValue(key: string): ConfigValue {
    const entry = getSchemaEntry(key);
    if (!entry) throw new Error(`no config key ${key}`);
    const v = readFileValue("global", key);
    if (v === undefined) return entry.default;
    if (typeof v === "number" && ((entry.min !== undefined && v < entry.min) || (entry.max !== undefined && v > entry.max))) return entry.default;
    return v;
}

/**
 * #3250 — an old key's value under its current name, from a parsed file
 * (`RENAMED_CONFIG_KEYS`, factor applied), and the renames found, to report.
 */
export function renamedFallback(raw: unknown, key: string): { value: unknown; from: string } | undefined {
    for (const [old, r] of Object.entries(RENAMED_CONFIG_KEYS)) {
        if (r.key !== key) continue;
        const legacy = walkDotted(raw, old);
        if (legacy === undefined) continue;
        return { value: typeof legacy === "number" ? Math.round(legacy * r.factor) : legacy, from: old };
    }
    return undefined;
}
