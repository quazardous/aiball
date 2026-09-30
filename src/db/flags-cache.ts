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
 * #3331 — a YAML change now empties the cache itself (`clearFlagsOnConfigChange`
 * in projects.ts), so the net went from 60 s to 10 min: every loop paid a full
 * rebuild (~350 ms) each minute, most of what held the event loop.
 *
 * #3383 — a write no longer repairs the entries: it marks the tickets it
 * touched on each live entry (`markDirty`), and the entry is repaired when it
 * is next READ. A write repaired every cached consumer at once (~6 ms each,
 * three times per posted message: most of what `message.post` cost), most of
 * them for a reader that would not ask before the next write. A reader still
 * never sees a value older than the last write.
 */
export const CEILING_MS = 600_000;

interface Entry { val: unknown; at: number; until: number; dirty: Set<number> | null }

/** An entry with more dirty tickets than this is dropped: a rebuild costs less than the repair. */
const MAX_DIRTY = 200;

/**
 * How the owner repairs one entry for the tickets named: the actionable set of
 * `consumerId` (answering those tickets' own deadline, a claim just taken or a
 * snooze just set, null when none), and the decision gate.
 */
export interface FlagsRepairers<A, D> {
    actionable: (consumerId: string | undefined, val: A, ticketIds: readonly number[]) => number | null;
    decisionGate: (val: D, ticketIds: readonly number[]) => void;
}
let repairers: FlagsRepairers<unknown, unknown> | null = null;

/** The owner (projects.ts) says how its entries are repaired; without it a dirty entry is dropped. */
export function setFlagsRepairers<A, D>(r: FlagsRepairers<A, D>): void {
    repairers = r as FlagsRepairers<unknown, unknown>;
}

/** The decision gate if it is live, repaired for the tickets written since; null otherwise. */
function liveDecisionGate(nowMs: number): Entry | null {
    if (!decisionGate) return null;
    if (nowMs >= decisionGate.until || (decisionGate.dirty && !repairers)) { decisionGate = null; return null; }
    if (decisionGate.dirty) {
        const ids = [...decisionGate.dirty];
        decisionGate.dirty = null;
        repairers!.decisionGate(decisionGate.val, ids);
    }
    return decisionGate;
}

/**
 * A consumer's entry if it is live, repaired for the tickets written since.
 * The repair can only bring the expiry FORWARD (the repaired tickets' own
 * deadline): naming some tickets proves nothing about the rest of the board,
 * so the ceiling still bounds how long a value lives without a full rebuild.
 */
function liveActionable(key: string, nowMs: number): Entry | null {
    const hit = actionable.get(key);
    if (!hit) return null;
    if (nowMs >= hit.until || (hit.dirty && !repairers)) { actionable.delete(key); return null; }
    if (hit.dirty) {
        const ids = [...hit.dirty];
        hit.dirty = null;
        const deadline = repairers!.actionable(key === ANON ? undefined : key, hit.val, ids);
        if (deadline != null && deadline < hit.until) hit.until = deadline;
        if (nowMs >= hit.until) { actionable.delete(key); return null; }
    }
    return hit;
}

let decisionGate: Entry | null = null;
const actionable = new Map<string, Entry>();
const ANON = "\0anon";

function expiry(nowMs: number, deadline: number | null | undefined): number {
    const cap = nowMs + CEILING_MS;
    return deadline != null && deadline < cap ? deadline : cap;
}

/** Cross-consumer decision-gate map, cached. `build` runs on miss. */
export function getCachedDecisionGate<T>(build: () => T, nowMs: number = Date.now()): T {
    const hit = liveDecisionGate(nowMs);
    if (hit) return hit.val as T;
    const val = build();
    decisionGate = { val, at: nowMs, until: expiry(nowMs, null), dirty: null };
    return val;
}

/**
 * #2682 — the live entries, without building on a miss. A scoped reader (the
 * backlog asks about one project's tickets) narrows a warm board-wide value
 * instead of recomputing its scope; on a miss it computes its scope as before,
 * and never seeds the cache from that partial answer.
 */
export function peekDecisionGate<T>(nowMs: number = Date.now()): T | null {
    const hit = liveDecisionGate(nowMs);
    return hit ? hit.val as T : null;
}
export function peekActionable<T>(consumerId: string | undefined, nowMs: number = Date.now()): T | null {
    const hit = liveActionable(consumerId ?? ANON, nowMs);
    return hit ? hit.val as T : null;
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
    const hit = liveActionable(key, nowMs);
    if (hit) return hit.val as T;
    const val = build();
    actionable.set(key, { val, at: nowMs, until: expiry(nowMs, deadlineOf(val)), dirty: null });
    return val;
}

/**
 * #2165 / #3383 — a write touched these tickets: every LIVE entry remembers
 * them and is repaired at its next read. Expired entries are dropped instead:
 * repairing one would resurrect a value whose OTHER, time-dependent parts (an
 * expired claim window, a snooze that came due) the write says nothing about.
 */
export function markDirty(ticketIds: readonly number[], nowMs: number = Date.now()): void {
    const mark = (e: Entry): boolean => {
        if (nowMs >= e.until) return false;
        e.dirty ??= new Set();
        for (const id of ticketIds) e.dirty.add(id);
        return e.dirty.size <= MAX_DIRTY;
    };
    if (decisionGate && !mark(decisionGate)) decisionGate = null;
    for (const [key, hit] of [...actionable]) {
        if (!mark(hit)) actionable.delete(key);
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
