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

function readOverride(project: string, key: string): ConfigValue | undefined {
    const row = getDb().select().from(schema.configOverrides)
        .where(and(eq(schema.configOverrides.project, project), eq(schema.configOverrides.key, key)))
        .get();
    return row ? parseStored(row.value) : undefined;
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
}

/** Remove an override at a layer (revert to the layer below). */
export function deleteConfigOverride(project: string, key: string): void {
    getDb().delete(schema.configOverrides)
        .where(and(eq(schema.configOverrides.project, project), eq(schema.configOverrides.key, key)))
        .run();
}
