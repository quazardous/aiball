// #1992 — deciding whether the compiled graph is stale. PURE, so it tests
// without a DB (same convention as landscape.ts / mention-extract.ts).
//
// WHY NOT A CONTENT HASH, which is the obvious first idea: computing one means
// reading the 13 MB of prose the check exists to avoid reading. The message log
// is append-only with monotonic ids, so a watermark gives the same guarantee
// for the price of an index lookup — and says BY HOW MUCH the log moved, not
// merely that it did.
//
// WHY NOT `landscapeHash` (#379), which already exists and looks like a fit:
// it is structural-only by explicit decision (#813) — it reflects membership of
// the open set and deliberately ignores intra-ticket activity, precisely so it
// does not move on every comment. The graph is compiled FROM comments. Reusing
// it would silently miss edges.

/** The three integers that stand in for "what the log looked like". */
export interface GraphVersion {
    /** max(_messages.id) — moves on an append. */
    throughId: number;
    /** count(*) — moves on a deletion, which leaves max(id) untouched. */
    messageCount: number;
    /**
     * count(original_body IS NOT NULL) — moves when a body is edited in place,
     * which moves neither of the other two.
     *
     * KNOWN GAP, named rather than hidden: a SECOND edit of an already-edited
     * message moves nothing at all, so its edges wait for the next recompile
     * that any other event triggers. In the corpus that is 18 messages out of
     * 16 364, and the wait is measured in minutes.
     */
    editedCount: number;
}

/**
 * Default drift before recompiling: one event, i.e. recompile whenever the log
 * moved at all.
 *
 * That sounds expensive and isn't. A full compile is ~200 ms, the consumers are
 * on-demand reads rather than a hot loop, and between two such reads the log
 * has usually not moved — so the cost is paid only when the answer would
 * otherwise be wrong. Buying latency back with a bigger threshold means paying
 * in staleness that nobody can see, which is the worse currency.
 */
export const DEFAULT_MIN_DRIFT = 1;

/**
 * Whether the compiled artifact needs rebuilding. `compiled` is null when
 * nothing has ever been compiled.
 */
export function needsRecompile(
    current: GraphVersion,
    compiled: GraphVersion | null,
    minDrift: number = DEFAULT_MIN_DRIFT,
): boolean {
    if (!compiled) return true;
    // A changed count means rows appeared or vanished under us; neither is
    // expressible as forward drift, so don't try to threshold it.
    if (current.messageCount !== compiled.messageCount) return true;
    if (current.editedCount !== compiled.editedCount) return true;
    const drift = current.throughId - compiled.throughId;
    // Backwards = the log was rewound (a restore, a wiped test DB). The
    // artifact then describes a future that no longer exists: trust nothing.
    if (drift < 0) return true;
    return drift >= Math.max(1, minDrift);
}

/** How far behind the artifact is, in events. 0 when it is current. */
export function versionDrift(current: GraphVersion, compiled: GraphVersion | null): number {
    if (!compiled) return current.throughId;
    return Math.max(0, current.throughId - compiled.throughId);
}
