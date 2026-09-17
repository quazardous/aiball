/**
 * #1168 (S3b de #1161) — flags-context cache.
 *
 * `decisionGateByTicket()` (cross-consumer, replays every decision event of
 * the base, ~40ms, called several times per request) and
 * `computeActionableTicketIds(consumerId)` (per-consumer, ~130-170ms) were
 * recomputed on every hit of every surface (inbox, tickets, backlog, wake
 * gate). Same model as the inbox-agg cache (#1167): memoize the built result,
 * EXACT write-invalidation, plus a TTL ceiling that self-heals any missed
 * invalidation path (and covers the time-dependent bits — claim-window expiry,
 * snooze reveal — that no write signals).
 *
 * Leaf module: it imports nothing, and knows nothing of the SHAPE of what it
 * holds. The builders are passed in as callbacks by the owner (projects.ts),
 * and so is the repair (#2165) — `repairEntries` hands each live entry back to
 * that owner rather than interpreting it here.
 *
 * The public entry point for a write is `invalidateFlagsCache()` in
 * projects.ts, NOT `clearFlagsCache()` below: naming the tickets a write
 * touched lets the owner repair those entries instead of dropping everything.
 *
 * #2682 — an entry lives until the NEXT moment its value can change on its own
 * (a snooze coming due, a claim expiring: the owner names it), capped by
 * CEILING_MS. The ceiling was 5 s and doubled as the clock for those time
 * effects; every loop re-asks every ~13 s, so nearly every read rebuilt
 * (150-300 ms each). With the time effects handled exactly, the ceiling is only
 * the net for a write that forgot to invalidate, and for the inputs that live
 * in the YAML config (claim window, automation rules), which no write signals.
 */
export const CEILING_MS = 60_000;

interface Entry { val: unknown; at: number; until: number }

let decisionGate: Entry | null = null;
const actionable = new Map<string, Entry>();
const ANON = "\0anon";

function expiry(nowMs: number, deadline: number | null | undefined): number {
    const cap = nowMs + CEILING_MS;
    return deadline != null && deadline < cap ? deadline : cap;
}

/** Cross-consumer decision-gate map, cached. `build` runs on miss. */
export function getCachedDecisionGate<T>(build: () => T, nowMs: number = Date.now()): T {
    if (decisionGate && nowMs < decisionGate.until) return decisionGate.val as T;
    const val = build();
    decisionGate = { val, at: nowMs, until: expiry(nowMs, null) };
    return val;
}

/**
 * Per-consumer actionable set, cached. `build` runs on miss. `deadlineOf` names
 * the epoch-ms at which the built value stops being true without any write
 * (null: never).
 */
export function getCachedActionable<T>(
    consumerId: string | undefined,
    build: () => T,
    nowMs: number = Date.now(),
    deadlineOf: (val: T) => number | null = () => null,
): T {
    const key = consumerId ?? ANON;
    const hit = actionable.get(key);
    if (hit && nowMs < hit.until) return hit.val as T;
    const val = build();
    actionable.set(key, { val, at: nowMs, until: expiry(nowMs, deadlineOf(val)) });
    return val;
}

/**
 * #2165 — hand every LIVE entry to its owner so it can be repaired in place.
 * Expired entries are dropped instead: repairing one would resurrect a value
 * whose OTHER, time-dependent parts (an expired claim window, a snooze that
 * came due) the write says nothing about.
 *
 * A repair does NOT push the expiry back, for the same reason — the ceiling
 * bounds how long a value may live without a full rebuild, and naming one
 * ticket proves nothing about the rest of the board. It can only bring it
 * FORWARD: `repairActionable` returns the repaired tickets' own deadline (a
 * claim just taken, a snooze just set), and the entry expires at the earlier.
 */
export function repairEntries<A, D>(
    repairActionable: (consumerId: string | undefined, val: A) => number | null,
    repairDecisionGate: (val: D) => void,
    nowMs: number = Date.now(),
): void {
    if (decisionGate) {
        if (nowMs >= decisionGate.until) decisionGate = null;
        else repairDecisionGate(decisionGate.val as D);
    }
    for (const [key, hit] of [...actionable]) {
        if (nowMs >= hit.until) {
            actionable.delete(key);
            continue;
        }
        const deadline = repairActionable(key === ANON ? undefined : key, hit.val as A);
        if (deadline != null && deadline < hit.until) hit.until = deadline;
    }
}

/** True when something is cached — lets the owner skip the repair's queries. */
export function flagsCacheIsCold(): boolean {
    return decisionGate === null && actionable.size === 0;
}

/**
 * Drop all cached flags-context. The fallback for a write that cannot name
 * what it touched (a project move), and the reset used by tests.
 */
export function clearFlagsCache(): void {
    decisionGate = null;
    actionable.clear();
}

/** Tests — force a cold cache. */
export function resetFlagsCacheForTests(): void {
    clearFlagsCache();
}
