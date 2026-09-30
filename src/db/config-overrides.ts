/**
 * #449 — storage + layered read for the unified config manager. The SCHEMA
 * (keys/scope/type/default/protected) is in code (src/config/schema.ts); this
 * module persists OVERRIDES (table `config_overrides`, `project=''` = global
 * layer) and resolves the effective value: project override → global override →
 * schema default. The resolver core is pure (no DB) so it unit-tests on its own.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import {
    CONFIG_SCHEMA,
    allowsGlobalOverride,
    allowsProjectOverride,
    effectiveSources,
    getSchemaEntry,
    groupOf,
    type ConfigSchemaEntry,
    type ConfigSource,
    type ConfigValue,
} from "../config/schema.js";
import { readFileValue } from "../config/file-reader.js";

/** PURE: pick the effective value — project beats global beats the default. */
export function resolveConfigValue(
    def: ConfigValue,
    globalOverride: ConfigValue | undefined,
    projectOverride: ConfigValue | undefined,
): ConfigValue {
    if (projectOverride !== undefined) return projectOverride;
    if (globalOverride !== undefined) return globalOverride;
    return def;
}

function parseStored(json: string): ConfigValue | undefined {
    try {
        const v: unknown = JSON.parse(json);
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    } catch { /* malformed → treat as absent */ }
    return undefined;
}

/**
 * #3383 — every override, kept in memory: the table is a few rows, and reading
 * it one key at a time cost a query per key and per layer (a backlog read asks
 * for some thirty). Dropped by the two writers below; the ceiling is the net
 * for a row written past them (another process, a restored database).
 */
const OVERRIDES_CEILING_MS = 10_000;
let overrides: { byLayerKey: Map<string, string>; until: number } | null = null;

function readOverride(project: string, key: string): ConfigValue | undefined {
    const now = Date.now();
    if (!overrides || now >= overrides.until) {
        const byLayerKey = new Map<string, string>();
        for (const r of getDb().select().from(schema.configOverrides).all()) byLayerKey.set(`${r.project}\0${r.key}`, r.value);
        overrides = { byLayerKey, until: now + OVERRIDES_CEILING_MS };
    }
    const stored = overrides.byLayerKey.get(`${project}\0${key}`);
    return stored !== undefined ? parseStored(stored) : undefined;
}

/** A write that went past the two writers below (a project renamed, a test's own row): read the table again. */
export function forgetConfigOverrides(): void {
    overrides = null;
}

/** #590 — read one (source × layer) value for an entry. Returns undefined
 *  when the layer is out of scope, the source isn't declared, or no value
 *  is set at that path. Pure dispatch; the DB / FILE specifics live in
 *  their own helpers. */
function readSourceLayer(
    entry: ConfigSchemaEntry,
    source: ConfigSource,
    layer: "project" | "global",
    project?: string | null,
    cwd?: string | null,
): ConfigValue | undefined {
    if (layer === "project" && !allowsProjectOverride(entry)) return undefined;
    if (layer === "global" && !allowsGlobalOverride(entry)) return undefined;
    if (source === "db") {
        if (layer === "project" && project) return readOverride(project, entry.key);
        if (layer === "global") return readOverride("", entry.key);
        return undefined;
    }
    // source === "file"
    if (layer === "project") return cwd ? readFileValue("project", entry.key, cwd) : undefined;
    return readFileValue("global", entry.key);
}

/**
 * The effective value of one key for an optional project, resolved through the
 * layers. Returns the schema default when there's no override; `undefined` only
 * when the key isn't in the schema. Synchronous (composes inside other queries,
 * e.g. ticket creation).
 *
 * #590 — resolution policy : **layer-first, then source-within-layer**.
 *   1. project layer : for each source in `effectiveSources(entry)`, first hit wins.
 *   2. global layer : same.
 *   3. schema default.
 *
 * Per-tree intent (project layer) always wins over server-wide (global layer);
 * within a layer, the more authoritative source wins (DB / UI by default beats
 * the committed FILE yaml). `cwd` is needed for FILE-source project reads —
 * omit when the caller doesn't have a per-project cwd context (legacy DB-only
 * keys keep working with `getConfig(key)` / `getConfig(key, project)`).
 */
export function getConfig(
    key: string,
    project?: string | null,
    cwd?: string | null,
): ConfigValue | undefined {
    const entry = getSchemaEntry(key);
    if (!entry) return undefined;
    const sources = effectiveSources(entry);
    for (const layer of ["project", "global"] as const) {
        for (const source of sources) {
            const v = readSourceLayer(entry, source, layer, project, cwd);
            if (v !== undefined) return v;
        }
    }
    return entry.default;
}

/** One resolved row for the settings UI: schema meta + each layer + effective. */
export interface ResolvedConfig {
    key: string;
    scope: string;
    type: string;
    options: readonly string[] | null;
    protected: boolean;
    label: string;
    description: string;
    /** #3147 — where it can be set, precedence first: `db` (`config.set`) and/or
     *  `file` (`.aiball.yaml`, the global config). A file-only key is not
     *  written by `config.set`, and its file value is not read here: this view
     *  has no project folder to find the file in. */
    sources: readonly ConfigSource[];
    /** #3137 — its section, and for a number its range, step and unit (null when none). */
    group: string;
    min: number | null;
    max: number | null;
    step: number | null;
    unit: string | null;
    default: ConfigValue;
    /** The global-layer override, or null when unset / not applicable. */
    global: ConfigValue | null;
    /** The project-layer override (when a project is in scope), or null. */
    project: ConfigValue | null;
    /** The effective value after layering. */
    value: ConfigValue;
}

/**
 * Every schema key resolved for an optional project, in one pass (one query for
 * the relevant layers). When `project` is set, project-layer overrides are
 * included; otherwise only the global layer. Drives the settings UI.
 */
export function getResolvedConfig(project?: string | null): ResolvedConfig[] {
    const layers = project ? ["", project] : [""];
    const rows = getDb().select().from(schema.configOverrides)
        .where(inArray(schema.configOverrides.project, layers))
        .all();
    const globalMap = new Map<string, ConfigValue>();
    const projectMap = new Map<string, ConfigValue>();
    for (const r of rows) {
        const v = parseStored(r.value);
        if (v === undefined) continue;
        (r.project === "" ? globalMap : projectMap).set(r.key, v);
    }
    return CONFIG_SCHEMA.map((entry) => {
        const g = allowsGlobalOverride(entry) ? globalMap.get(entry.key) : undefined;
        const p = project && allowsProjectOverride(entry) ? projectMap.get(entry.key) : undefined;
        return {
            key: entry.key,
            scope: entry.scope,
            type: entry.type,
            options: entry.options ?? null,
            protected: !!entry.protected,
            label: entry.label,
            description: entry.description,
            sources: effectiveSources(entry),
            group: groupOf(entry.key),
            min: entry.min ?? null,
            max: entry.max ?? null,
            step: entry.step ?? null,
            unit: entry.unit ?? null,
            default: entry.default,
            global: g ?? null,
            project: p ?? null,
            value: resolveConfigValue(entry.default, g, p),
        };
    });
}

/** Upsert an override at a layer (`project=''` for global). */
export function setConfigOverride(
    project: string,
    key: string,
    value: ConfigValue,
    updatedBy?: string | null,
): void {
    const now = nowIso();
    const encoded = JSON.stringify(value);
    getDb().insert(schema.configOverrides).values({
        project, key, value: encoded, updatedAt: now, updatedBy: updatedBy ?? null,
    }).onConflictDoUpdate({
        target: [schema.configOverrides.project, schema.configOverrides.key],
        set: { value: encoded, updatedAt: now, updatedBy: updatedBy ?? null },
    }).run();
    overrides = null;
}

/** Remove an override at a layer (revert to the layer below). */
export function deleteConfigOverride(project: string, key: string): void {
    getDb().delete(schema.configOverrides)
        .where(and(eq(schema.configOverrides.project, project), eq(schema.configOverrides.key, key)))
        .run();
    overrides = null;
}
