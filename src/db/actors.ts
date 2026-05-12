/**
 * Actor registry (#B.79). One row per known consumer_id, with a `kind`
 * (human / agent), display label, and enabled flag.
 *
 * Replaces the hardcoded `process.env.AIBALL_HUMAN ?? "human"` checks
 * sprinkled across the codebase. `isHuman()` is the single source of
 * truth for "should this consumer get moderator privileges".
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export type ActorKind = "human" | "agent";

export interface Actor {
    consumer_id: string;
    kind: ActorKind;
    display_name: string | null;
    enabled: boolean;
    note: string | null;
    created_at: string;
    updated_at: string;
}

function rowToActor(r: schema.Actor): Actor {
    return {
        consumer_id: r.consumerId,
        kind: (r.kind as ActorKind) ?? "agent",
        display_name: r.displayName,
        enabled: r.enabled === 1,
        note: r.note,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
    };
}

export function listActors(): Actor[] {
    const rows = getDb().select().from(schema.actors)
        .orderBy(asc(schema.actors.kind), asc(schema.actors.consumerId))
        .all();
    return rows.map(rowToActor);
}

export function getActor(consumer_id: string): Actor | null {
    const r = getDb().select().from(schema.actors)
        .where(eq(schema.actors.consumerId, consumer_id))
        .get();
    return r ? rowToActor(r) : null;
}

/**
 * Lazy-insert. Called on the hot path whenever a new `by_agent` or
 * recipient is seen — defaults to kind=agent + enabled. No-op when the
 * row already exists. Tolerates concurrent inserts via `ON CONFLICT
 * DO NOTHING`.
 */
export function ensureActor(consumer_id: string): void {
    if (!consumer_id) return;
    const now = nowIso();
    getDb().insert(schema.actors).values({
        consumerId: consumer_id,
        kind: "agent",
        enabled: 1,
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing().run();
}

/**
 * Returns true iff `consumer_id` is registered with kind=human AND
 * enabled. This is THE check for moderator-class bypass — every
 * codepath that used to compare against `$AIBALL_HUMAN` should use
 * this instead.
 *
 * Defensive fallback: when the table is empty or the value is the
 * literal default `"human"` (no migration backfill yet), still return
 * true. Belt-and-suspenders for environments that boot before the
 * migration runs.
 */
/**
 * Return the consumer_ids of every actor with kind=human + enabled.
 * Used by fanOutPings (recipient set for pending posts) and by the
 * rule engine (moderation bypass set). Cheap — small table.
 */
export function listHumans(): string[] {
    const rows = getDb().select({ consumerId: schema.actors.consumerId })
        .from(schema.actors)
        .where(and(eq(schema.actors.kind, "human"), eq(schema.actors.enabled, 1)))
        .all();
    return rows.map((r) => r.consumerId);
}

export function isHuman(consumer_id: string): boolean {
    if (!consumer_id) return false;
    const r = getDb().select({
        kind: schema.actors.kind,
        enabled: schema.actors.enabled,
    }).from(schema.actors)
        .where(eq(schema.actors.consumerId, consumer_id))
        .get();
    if (r) return r.kind === "human" && r.enabled === 1;
    // No row yet — fallback to the env CSV that the old code used so a
    // freshly booted daemon doesn't lock out the moderator before the
    // first ensureActor() call. AIBALL_HUMAN defaults to "human".
    const env = (process.env.AIBALL_HUMAN ?? "human")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return env.includes(consumer_id);
}

export interface UpdateActorPatch {
    kind?: ActorKind;
    display_name?: string | null;
    enabled?: boolean;
    note?: string | null;
}

export function updateActor(consumer_id: string, patch: UpdateActorPatch): Actor | null {
    const row: Partial<schema.NewActorRow> = {
        updatedAt: nowIso(),
    };
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.display_name !== undefined) row.displayName = patch.display_name;
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0;
    if (patch.note !== undefined) row.note = patch.note;
    const r = getDb().update(schema.actors)
        .set(row)
        .where(eq(schema.actors.consumerId, consumer_id))
        .run();
    if (r.changes === 0) return null;
    return getActor(consumer_id);
}

/**
 * Explicit create — used by the admin endpoint when pre-declaring an
 * actor (e.g. marking a new human moderator BEFORE they post). Insert
 * or update existing.
 */
export function upsertActor(input: {
    consumer_id: string;
    kind?: ActorKind;
    display_name?: string | null;
    enabled?: boolean;
    note?: string | null;
}): Actor {
    const now = nowIso();
    const existing = getActor(input.consumer_id);
    if (existing) {
        return updateActor(input.consumer_id, {
            kind: input.kind,
            display_name: input.display_name,
            enabled: input.enabled,
            note: input.note,
        }) ?? existing;
    }
    getDb().insert(schema.actors).values({
        consumerId: input.consumer_id,
        kind: input.kind ?? "agent",
        displayName: input.display_name ?? null,
        enabled: (input.enabled ?? true) ? 1 : 0,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
    }).run();
    return getActor(input.consumer_id)!;
}

export function deleteActor(consumer_id: string): boolean {
    const r = getDb().delete(schema.actors)
        .where(eq(schema.actors.consumerId, consumer_id))
        .run();
    return r.changes > 0;
}

/**
 * Batch lookup — used by /api/projects?detailed and similar where we
 * have a list of consumer_ids and want their actor kind in one query.
 */
export function getActorsByIds(ids: string[]): Map<string, Actor> {
    const out = new Map<string, Actor>();
    if (ids.length === 0) return out;
    const rows = getDb().select().from(schema.actors)
        .where(inArray(schema.actors.consumerId, ids))
        .all();
    for (const r of rows) out.set(r.consumerId, rowToActor(r));
    return out;
}

