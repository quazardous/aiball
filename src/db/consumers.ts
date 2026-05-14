/**
 * Consumer registry (#B.79). One row per known consumer_id, with a
 * `kind` (human / agent), display label, and enabled flag.
 *
 * Replaces the hardcoded `process.env.AIBALL_HUMAN ?? "human"` checks
 * sprinkled across the codebase. `isHuman()` is the single source of
 * truth for "should this consumer get moderator privileges".
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export type ConsumerKind = "human" | "agent" | "sandbox";

export interface Consumer {
    consumer_id: string;
    kind: ConsumerKind;
    display_name: string | null;
    enabled: boolean;
    note: string | null;
    /** Whether this consumer has a password set (for human web login). */
    has_password?: boolean;
    last_login_at?: string | null;
    created_at: string;
    updated_at: string;
}

function rowToConsumer(r: schema.Consumer): Consumer {
    return {
        consumer_id: r.consumerId,
        kind: (r.kind as ConsumerKind) ?? "agent",
        display_name: r.displayName,
        enabled: r.enabled === 1,
        note: r.note,
        has_password: !!r.passwordHash,
        last_login_at: r.lastLoginAt,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
    };
}

/** Fetch the password hash directly (returned only by the auth module). */
export function getPasswordHash(consumer_id: string): string | null {
    const r = getDb().select({ ph: schema.consumers.passwordHash })
        .from(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .get();
    return r?.ph ?? null;
}

export function setPasswordHash(consumer_id: string, hash: string): boolean {
    const r = getDb().update(schema.consumers)
        .set({ passwordHash: hash, updatedAt: nowIso() })
        .where(eq(schema.consumers.consumerId, consumer_id))
        .run();
    return r.changes > 0;
}

export function touchLastLogin(consumer_id: string): void {
    const now = nowIso();
    getDb().update(schema.consumers)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(schema.consumers.consumerId, consumer_id))
        .run();
}

export function listConsumers(): Consumer[] {
    const rows = getDb().select().from(schema.consumers)
        .orderBy(asc(schema.consumers.kind), asc(schema.consumers.consumerId))
        .all();
    return rows.map(rowToConsumer);
}

export function getConsumer(consumer_id: string): Consumer | null {
    const r = getDb().select().from(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .get();
    return r ? rowToConsumer(r) : null;
}

/**
 * Lazy-insert. Called on the hot path whenever a new `by_agent` or
 * recipient is seen — defaults to kind=agent + enabled. No-op when the
 * row already exists. Tolerates concurrent inserts via
 * `onConflictDoNothing`.
 */
export function ensureConsumer(consumer_id: string): void {
    if (!consumer_id) return;
    const now = nowIso();
    getDb().insert(schema.consumers).values({
        consumerId: consumer_id,
        kind: "agent",
        enabled: 1,
        createdAt: now,
        updatedAt: now,
    }).onConflictDoNothing().run();
}

/**
 * Return the consumer_ids of every consumer with kind=human + enabled.
 * Used by fanOutPings (recipient set for pending posts) and by the
 * rule engine (moderation bypass set). Cheap — small table.
 */
export function listHumans(): string[] {
    const rows = getDb().select({ consumerId: schema.consumers.consumerId })
        .from(schema.consumers)
        .where(and(eq(schema.consumers.kind, "human"), eq(schema.consumers.enabled, 1)))
        .all();
    return rows.map((r) => r.consumerId);
}

/**
 * Returns true iff `consumer_id` is registered with kind=human AND
 * enabled. This is THE check for moderator-class bypass — every
 * codepath that used to compare against `$AIBALL_HUMAN` should use
 * this instead.
 *
 * Defensive fallback: when the table is empty or the value isn't
 * present (no migration backfill yet), fall back to the AIBALL_HUMAN
 * env CSV (default `"human"`). Belt-and-suspenders for environments
 * that boot before the migration runs.
 */
export function isHuman(consumer_id: string): boolean {
    if (!consumer_id) return false;
    const r = getDb().select({
        kind: schema.consumers.kind,
        enabled: schema.consumers.enabled,
    }).from(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .get();
    if (r) return r.kind === "human" && r.enabled === 1;
    const env = (process.env.AIBALL_HUMAN ?? "human")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return env.includes(consumer_id);
}

export interface UpdateConsumerPatch {
    kind?: ConsumerKind;
    display_name?: string | null;
    enabled?: boolean;
    note?: string | null;
}

export function updateConsumer(consumer_id: string, patch: UpdateConsumerPatch): Consumer | null {
    const row: Partial<schema.NewConsumerRow> = {
        updatedAt: nowIso(),
    };
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.display_name !== undefined) row.displayName = patch.display_name;
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0;
    if (patch.note !== undefined) row.note = patch.note;
    const r = getDb().update(schema.consumers)
        .set(row)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .run();
    if (r.changes === 0) return null;
    return getConsumer(consumer_id);
}

/**
 * Explicit create — used by the admin endpoint when pre-declaring a
 * consumer (e.g. marking a new human moderator BEFORE they post).
 * Insert or update existing.
 */
export function upsertConsumer(input: {
    consumer_id: string;
    kind?: ConsumerKind;
    display_name?: string | null;
    enabled?: boolean;
    note?: string | null;
}): Consumer {
    const now = nowIso();
    const existing = getConsumer(input.consumer_id);
    if (existing) {
        return updateConsumer(input.consumer_id, {
            kind: input.kind,
            display_name: input.display_name,
            enabled: input.enabled,
            note: input.note,
        }) ?? existing;
    }
    getDb().insert(schema.consumers).values({
        consumerId: input.consumer_id,
        kind: input.kind ?? "agent",
        displayName: input.display_name ?? null,
        enabled: (input.enabled ?? true) ? 1 : 0,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
    }).run();
    return getConsumer(input.consumer_id)!;
}

export function deleteConsumer(consumer_id: string): boolean {
    const r = getDb().delete(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .run();
    return r.changes > 0;
}

/**
 * Batch lookup — used by /api/projects?detailed and similar where we
 * have a list of consumer_ids and want their kind in one query.
 */
export function getConsumersByIds(ids: string[]): Map<string, Consumer> {
    const out = new Map<string, Consumer>();
    if (ids.length === 0) return out;
    const rows = getDb().select().from(schema.consumers)
        .where(inArray(schema.consumers.consumerId, ids))
        .all();
    for (const r of rows) out.set(r.consumerId, rowToConsumer(r));
    return out;
}
