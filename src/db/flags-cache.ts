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
 * Leaf module (no DB imports) so the write chokepoints in db/messages.ts can
 * call `invalidateFlagsCache()` without an import cycle. The builders are
 * passed in as callbacks by the owners in projects.ts.
 */
const TTL_MS = 5_000;

let decisionGate: { val: unknown; at: number } | null = null;
const actionable = new Map<string, { val: unknown; at: number }>();
const ANON = "\0anon";

/** Cross-consumer decision-gate map, cached. `build` runs on miss. */
export function getCachedDecisionGate<T>(build: () => T, nowMs: number = Date.now()): T {
    if (decisionGate && nowMs - decisionGate.at < TTL_MS) return decisionGate.val as T;
    const val = build();
    decisionGate = { val, at: nowMs };
    return val;
}

/** Per-consumer actionable set, cached. `build` runs on miss. */
export function getCachedActionable<T>(consumerId: string | undefined, build: () => T, nowMs: number = Date.now()): T {
    const key = consumerId ?? ANON;
    const hit = actionable.get(key);
    if (hit && nowMs - hit.at < TTL_MS) return hit.val as T;
    const val = build();
    actionable.set(key, { val, at: nowMs });
    return val;
}

/**
 * Drop all cached flags-context. Called from every message write chokepoint
 * and the claim/assign/release paths. Coarse by design — these sets are small
 * to rebuild and cross-consumer coupling (a decision on one thread shifts
 * everyone's gate) makes per-key invalidation not worth the bookkeeping.
 */
export function invalidateFlagsCache(): void {
    decisionGate = null;
    actionable.clear();
}

/** Tests — force a cold cache. */
export function resetFlagsCacheForTests(): void {
    invalidateFlagsCache();
}
