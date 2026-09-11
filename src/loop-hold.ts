/**
 * #2333 — the all-agents message and hold, before the operator leaves: which
 * loops it reaches, and what each one reports back. Pure (no Express, no DB),
 * so it tests without a daemon.
 */

/** A consumer as the pick needs it. */
export interface LoopCandidate {
    consumer_id: string;
    kind: string;
    /** Live-presence verdict: true = a loop is connected now. */
    present: boolean | null;
}

/** One loop's outcome in a message-all / release-all. */
export interface LoopHoldResult {
    consumer_id: string;
    /** Set on a message: typed into the live session now, or queued until the loop reconnects. */
    prompt?: "delivered" | "spooled";
    /** Set when a hold was asked (armed) or released, or could not be. */
    hold?: "armed" | "released" | "failed";
    hold_error?: string;
}

/**
 * The agent loops an all-loops control reaches: every consumer with a loop
 * connected right now that is not a human or the system — narrowed to `named`
 * when the caller lists some. Sorted, so the reply reads the same every time.
 */
export function pickHoldTargets(candidates: readonly LoopCandidate[], named?: readonly string[] | null): string[] {
    const wanted = named && named.length > 0 ? new Set(named) : null;
    return candidates
        .filter((c) => c.kind !== "human" && c.kind !== "system" && c.present === true)
        .filter((c) => !wanted || wanted.has(c.consumer_id))
        .map((c) => c.consumer_id)
        .sort();
}
