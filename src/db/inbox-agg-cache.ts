/**
 * #2168 — the STORE behind the inbox aggregate, split out from the fold.
 *
 * It exists for one reason: `projects.ts` has to drop this cache when a
 * project is deleted, renamed or purged, and it cannot import `inbox-agg.ts`
 * to do it. That module reads `messages.ts`, which since #2165 reads
 * `projects.ts` — so the obvious import closes a cycle:
 *
 *     projects.ts -> inbox-agg.ts -> messages.ts -> projects.ts
 *
 * This is the same shape, and the same answer, as `flags-cache.ts` vis-à-vis
 * `projects.ts`: a leaf that imports NOTHING and knows nothing of the SHAPE it
 * holds. The fold, the repair and the `InboxAgg` type all stay next door in
 * `inbox-agg.ts`, which is the single source of truth for what an entry means.
 *
 * The TTL lives here because it is a property of the store, not of the fold: a
 * ceiling on how long any entry may survive without a rebuild, so a write path
 * that forgets to speak up degrades to a few seconds of staleness rather than
 * a permanently wrong inbox.
 */
const TTL_MS = 5_000;

/** Cache key for the cross-project view. */
export const ALL_PROJECTS = "\0all";

const cache = new Map<string, { agg: unknown; builtAtMs: number }>();

export function inboxAggKey(project: string | undefined): string {
    return project ?? ALL_PROJECTS;
}

/** The cached map for `key`, or undefined when absent OR past the TTL. */
export function getFreshInboxAgg<T>(key: string, nowMs: number): T | undefined {
    const hit = cache.get(key);
    if (hit && nowMs - hit.builtAtMs < TTL_MS) return hit.agg as T;
    return undefined;
}

export function setInboxAgg(key: string, agg: unknown, nowMs: number): void {
    cache.set(key, { agg, builtAtMs: nowMs });
}

/**
 * The cached map for `key` REGARDLESS of its age — what the repair patches.
 * Deliberately TTL-blind: an entry about to expire is still the map readers
 * are holding right now, and repairing it costs nothing when it is dropped a
 * moment later. Repairing does not refresh `builtAtMs`, so the ceiling still
 * applies to the entry as a whole.
 */
export function peekInboxAgg<T>(key: string): T | undefined {
    return cache.get(key)?.agg as T | undefined;
}

/**
 * Drop cached maps. With a project name, that project and the cross-project
 * view (any write to a project changes it); with nothing, everything.
 *
 * This is the whole reason the module exists — `projects.ts` calls it after
 * deleting, renaming or purging, where the blast radius is a whole project and
 * no per-ticket repair applies.
 */
export function clearInboxAgg(project?: string | null): void {
    if (project) {
        cache.delete(project);
        cache.delete(ALL_PROJECTS);
        return;
    }
    cache.clear();
}
