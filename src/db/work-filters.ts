/**
 * #447 — per-agent WORK FILTERS: narrow which tickets a consumer (agent) picks
 * up, by tag. e.g. "the aiball-windows agent only works tickets tagged win".
 *
 * Stored in the daemon DB (NOT per-machine config) so every loop that talks to
 * this daemon shares the same filter — the linux + windows loops hit one daemon
 * DB, which is what makes the cross-machine case work without syncing files.
 *
 * The pure evaluator (`ticketPassesWorkFilters`) has no DB dependency, so the
 * gate logic unit-tests on its own. CRUD mirrors db/rules.ts. The gate
 * (computeActionableTicketIds) reads via the fail-open accessor.
 */
import { and, asc, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export type WorkFilterMode = "only" | "except";

/** API-facing shape (snake_case); match_tags decoded from JSON to string[]. */
export interface WorkFilter {
    id: number;
    consumer_id: string;
    project: string | null;
    mode: WorkFilterMode;
    match_tags: string[];
    enabled: number;
    position: number;
    note: string | null;
    created_at: string;
}

export interface NewWorkFilter {
    consumer_id: string;
    project?: string | null;
    mode?: WorkFilterMode;
    match_tags?: string[];
    note?: string | null;
    position?: number;
}

function parseTags(json: string): string[] {
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
    } catch {
        return [];
    }
}

function normMode(m: string | null | undefined): WorkFilterMode {
    return m === "except" ? "except" : "only";
}

function rowToWorkFilter(r: schema.WorkFilterRow): WorkFilter {
    return {
        id: r.id,
        consumer_id: r.consumerId,
        project: r.project,
        mode: normMode(r.mode),
        match_tags: parseTags(r.matchTags),
        enabled: r.enabled,
        position: r.position,
        note: r.note,
        created_at: r.createdAt,
    };
}

export function insertWorkFilter(f: NewWorkFilter): WorkFilter {
    const inserted = getDb().insert(schema.workFilters).values({
        consumerId: f.consumer_id,
        project: f.project ?? null,
        mode: normMode(f.mode),
        matchTags: JSON.stringify(f.match_tags ?? []),
        enabled: 1,
        position: f.position ?? 0,
        note: f.note ?? null,
        createdAt: nowIso(),
    }).returning().get();
    return rowToWorkFilter(inserted);
}

export function listWorkFilters(opts: { consumerId?: string; enabledOnly?: boolean } = {}): WorkFilter[] {
    let q = getDb().select().from(schema.workFilters).$dynamic();
    const conds = [];
    if (opts.consumerId) conds.push(eq(schema.workFilters.consumerId, opts.consumerId));
    if (opts.enabledOnly) conds.push(eq(schema.workFilters.enabled, 1));
    if (conds.length) q = q.where(conds.length === 1 ? conds[0] : and(...conds));
    return q.orderBy(asc(schema.workFilters.position), asc(schema.workFilters.id)).all().map(rowToWorkFilter);
}

export function deleteWorkFilter(id: number): void {
    getDb().delete(schema.workFilters).where(eq(schema.workFilters.id, id)).run();
}

export function setWorkFilterEnabled(id: number, enabled: boolean): WorkFilter | null {
    const db = getDb();
    db.update(schema.workFilters).set({ enabled: enabled ? 1 : 0 })
        .where(eq(schema.workFilters.id, id)).run();
    const r = db.select().from(schema.workFilters).where(eq(schema.workFilters.id, id)).get();
    return r ? rowToWorkFilter(r) : null;
}

/**
 * Fail-open read for the gate: a consumer's ENABLED filters. Wrapped so a read
 * error (e.g. migration 0037 not yet applied on a hot-reloaded tsx daemon, or
 * any transient DB error) degrades to "no filters" — we never hide an agent's
 * work because the filter table couldn't be read.
 */
export function getEnabledWorkFiltersForConsumer(consumerId: string): WorkFilter[] {
    try {
        return listWorkFilters({ consumerId, enabledOnly: true });
    } catch {
        return [];
    }
}

/**
 * PURE gate predicate (#447): does a ticket pass a consumer's work filters?
 *
 * A filter is "applicable" when its project is null (all the consumer's
 * projects) or equals the ticket's project. A ticket "matches" a filter when it
 * carries ≥1 of the filter's tags (any-of). Then:
 *   - `except`: if the ticket matches ANY applicable except-filter → out.
 *   - `only`: if there are applicable only-filters, the ticket must match ≥1 →
 *     else out.
 * No applicable filters → passes. Empty `filters` → passes (common path).
 */
export function ticketPassesWorkFilters(
    ticketProject: string,
    ticketTagNames: string[],
    filters: WorkFilter[],
): boolean {
    const applicable = filters.filter((f) => f.project == null || f.project === ticketProject);
    if (applicable.length === 0) return true;
    const tagSet = new Set(ticketTagNames);
    const matches = (f: WorkFilter): boolean => f.match_tags.some((t) => tagSet.has(t));
    if (applicable.some((f) => f.mode === "except" && matches(f))) return false;
    const onlys = applicable.filter((f) => f.mode === "only");
    if (onlys.length > 0 && !onlys.some(matches)) return false;
    return true;
}
