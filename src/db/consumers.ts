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

export type ConsumerState = "boot" | "idle" | "busy";

/** #310: 3-state human-presence word, mirrors the tmux bar's presence chip. */
export type HumanWord = "stop" | "wait" | "loop";

export interface Consumer {
    consumer_id: string;
    kind: ConsumerKind;
    display_name: string | null;
    enabled: boolean;
    note: string | null;
    /** Whether this consumer has a password set (for human web login). */
    has_password?: boolean;
    last_login_at?: string | null;
    /** #B.177: ISO8601 of the last API request this consumer made. */
    last_seen_at?: string | null;
    /** #B.177 B1: current claude-loop state, null if not a loop agent. */
    state?: ConsumerState | null;
    /** #B.177 B1: when current state was entered. */
    state_since?: string | null;
    /** #B.177 B1: last state heartbeat — UI uses this for offline detection. */
    state_updated_at?: string | null;
    /** #280: live human-presence — true when a human is driving the loop
     *  (typing / within user-grace) at the last heartbeat. null = never
     *  reported / not a loop agent. */
    state_human?: boolean | null;
    /** #310: 3-state human-presence word (stop/wait/loop) at the last
     *  heartbeat — mirrors the tmux bar. null = never reported / pre-#310 loop
     *  (fall back to `state_human` for the binary view). */
    state_human_word?: HumanWord | null;
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
        last_seen_at: r.lastSeenAt,
        state: (r.state as ConsumerState | null) ?? null,
        state_since: r.stateSince,
        state_updated_at: r.stateUpdatedAt,
        state_human: r.stateHuman == null ? null : r.stateHuman === 1,
        state_human_word: (r.stateHumanWord as HumanWord | null) ?? null,
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

/**
 * Bump `last_seen_at` to now (#B.177). Called from the request
 * middleware on every API call that resolves a consumer header.
 * Cheap: single column update, no read first. Silent no-op when
 * the consumer row doesn't exist (ensureConsumer covers creation).
 */
export function touchLastSeen(consumer_id: string): void {
    if (!consumer_id) return;
    const now = nowIso();
    getDb().update(schema.consumers)
        .set({ lastSeenAt: now })
        .where(eq(schema.consumers.consumerId, consumer_id))
        .run();
}

/**
 * Push the claude-loop state for this consumer (#B.177 B1). On state
 * change, `state_since` advances (transition timestamp). On every
 * call, `state_updated_at` is touched — the heartbeat freshness
 * signal the UI uses for "offline" detection.
 */
export function setConsumerState(
    consumer_id: string,
    state: ConsumerState,
    human?: boolean,
    humanWord?: HumanWord,
): void {
    if (!consumer_id) return;
    const now = nowIso();
    const cur = getDb().select({ state: schema.consumers.state })
        .from(schema.consumers)
        .where(eq(schema.consumers.consumerId, consumer_id))
        .get();
    const changed = cur?.state !== state;
    const patch: Partial<schema.NewConsumerRow> = {
        state,
        stateUpdatedAt: now,
        updatedAt: now,
    };
    // #280: only touch the human flag when the caller reports it (the loop
    // timer always does); legacy callers leave it untouched.
    if (human !== undefined) patch.stateHuman = human ? 1 : 0;
    // #310: the finer 3-state presence word, pushed alongside the boolean.
    if (humanWord !== undefined) patch.stateHumanWord = humanWord;
    if (changed) patch.stateSince = now;
    getDb().update(schema.consumers)
        .set(patch)
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
