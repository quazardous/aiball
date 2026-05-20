/**
 * ProjectPrefs SDK (#B.224).
 *
 * One place where per-project preferences live, behind a typed
 * `getPref / setPref / listPrefs` surface. Storage is a real column on
 * the `projects` table per preference — not a k/v hack, not a JSON
 * blob. Adding a new preference is one migration (new column) + one
 * `PREF_DEFS` entry + the type field on `ProjectPrefs` — no caller
 * touches storage details.
 *
 * Why columns and not JSON: David asked for a "clear" service. Columns
 * surface in `PRAGMA table_info(projects)`, support per-column CHECK
 * constraints, and stay queryable (future ORDER BY default_priority,
 * GROUP BY default_strategy, ...). JSON would be more elastic but less
 * transparent — and we're at migration #19, schema churn is cheap.
 *
 * Surface kept minimal — three functions, no caching layer. The
 * underlying SELECT is a single PK lookup on a tiny table; the rule
 * engine reads strategy on every moderation pass without measurable
 * cost. Add a cache only if a real hot path appears.
 */
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { getDb } from "./db/connection.js";
import { isStrategy, type Strategy } from "./domain.js";

export interface ProjectPrefs {
    /** Per-project moderation strategy override (#B.127, rebased
     *  here in #B.224). NULL/undefined → fall back to the global. */
    strategy?: Strategy;
}

export type ProjectPrefKey = keyof ProjectPrefs;

/**
 * Per-preference adapter: column name on `projects`, how to read a row,
 * how to write a value. Adding a new pref = add a key to ProjectPrefs +
 * an entry here + the migration adding the column. No other code touches
 * the storage shape.
 */
interface PrefDef<K extends ProjectPrefKey> {
    /** Drizzle SQL column for `update().set({...})`. */
    column: keyof typeof schema.projects.$inferSelect;
    /** Read a row into the typed value (or undefined when absent / invalid). */
    read(row: schema.Project): ProjectPrefs[K] | undefined;
    /** Validate + coerce a value to the SQL-bound form (string or null). */
    encode(value: ProjectPrefs[K] | null | undefined): string | null;
}

const PREF_DEFS: { [K in ProjectPrefKey]: PrefDef<K> } = {
    strategy: {
        column: "defaultStrategy",
        read: (r) => (r.defaultStrategy && isStrategy(r.defaultStrategy))
            ? r.defaultStrategy
            : undefined,
        encode: (v) => {
            if (v === null || v === undefined) return null;
            if (!isStrategy(v)) {
                throw new Error(`invalid strategy: ${String(v)}`);
            }
            return v;
        },
    },
};

/**
 * Read one preference. Returns `undefined` when the project doesn't
 * exist, or when the column is NULL / fails its type guard.
 */
export function getPref<K extends ProjectPrefKey>(
    project: string,
    key: K,
): ProjectPrefs[K] | undefined {
    if (!project) return undefined;
    const row = getDb().select().from(schema.projects)
        .where(eq(schema.projects.name, project))
        .get();
    if (!row) return undefined;
    return PREF_DEFS[key].read(row);
}

/**
 * Set one preference. Pass `null` (or `undefined`) to clear it back to
 * the global default. Throws on invalid value (e.g. an unknown enum
 * member). Silently no-ops when the project row doesn't exist —
 * callers can `createProject` first.
 */
export function setPref<K extends ProjectPrefKey>(
    project: string,
    key: K,
    value: ProjectPrefs[K] | null,
): void {
    if (!project) throw new Error("project required");
    const def = PREF_DEFS[key];
    const encoded = def.encode(value);
    // Build the patch dynamically — drizzle's `.set()` accepts a partial
    // typed object, so we cast through to satisfy its generic.
    const patch = { [def.column]: encoded } as Partial<typeof schema.projects.$inferInsert>;
    getDb().update(schema.projects)
        .set(patch)
        .where(eq(schema.projects.name, project))
        .run();
}

/**
 * Read every preference set on a project as a typed object. Keys with
 * NULL columns are omitted (caller can distinguish "not set" from "set
 * to default" — there's no "default" pseudo-value here, NULL means
 * inherit global).
 */
export function listPrefs(project: string): ProjectPrefs {
    if (!project) return {};
    const row = getDb().select().from(schema.projects)
        .where(eq(schema.projects.name, project))
        .get();
    if (!row) return {};
    const out: ProjectPrefs = {};
    for (const k of Object.keys(PREF_DEFS) as ProjectPrefKey[]) {
        const v = PREF_DEFS[k].read(row);
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}
