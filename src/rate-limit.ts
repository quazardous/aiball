/**
 * #3248 — a sliding-window limiter, per key (a signal's source, a pairing
 * request's address). `hit` records an attempt and says whether it may go on.
 * `countRefused`: whether a refused attempt counts toward the window too (a
 * pairing flood stays shut while it keeps knocking), or only the ones let in.
 */
export function slidingLimiter(opts: { windowMs: number; max: number; countRefused?: boolean; maxKeys?: number }): { hit(key: string, nowMs?: number): boolean } {
    const hits = new Map<string, number[]>();
    return {
        hit(key, nowMs = Date.now()) {
            const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < opts.windowMs);
            const allowed = recent.length < opts.max;
            if (allowed || opts.countRefused) recent.push(nowMs);
            hits.set(key, recent);
            // Bounded: one entry per active key, the idle ones pruned past the cap.
            if (hits.size > (opts.maxKeys ?? 500)) {
                for (const [k, v] of hits) if (v.every((t) => nowMs - t >= opts.windowMs)) hits.delete(k);
            }
            return allowed;
        },
    };
}
