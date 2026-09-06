// #2070 — deciding whether a new ticket is a cross-project deposit, and where
// it came from. PURE logic, extracted so it tests without a DB (same convention
// as landscape.ts / last-actor-gate.ts / mention-extract.ts).
//
// WHY THIS EXISTS. `from_project` has been in the schema since #697, is
// documented as "origin project for cross-project tickets", and renders a
// "from X" badge on the reading side — and it was NULL on every ticket ever
// filed, because it only ever got set when an agent thought to pass it, and
// none did. Field present, mechanism dead: the same shape `ticket_referenced`
// had before it was measured.
//
// What that cost, concretely: `jobbox-claude` filed ten tickets, three of them
// into a project it has no role in. One of those three was a deliberate
// cross-project announcement and entirely right; the other two were mistakes.
// Nothing distinguished them, because filing next door and filing next door BY
// MISTAKE produce exactly the same silence.
//
// So this does not forbid anything. Filing into a neighbouring project is the
// first legitimate reason to open a ticket at all. It only makes the crossing
// visible, which is what lets a wrong one be noticed.

/** The shape this needs from a subscription row — nothing more. */
export interface OriginSubscription {
    project: string;
    role?: string | null;
}

/**
 * The project a ticket came FROM, or null when there is nothing to mark.
 *
 * Null in three distinct cases, and the third is the one worth stating:
 *
 * 1. The filer is subscribed to the target — an ordinary intra-project ticket.
 * 2. The filer has no subscriptions at all — typically a brand-new agent
 *    filing its first ticket. We cannot know its origin, and guessing would
 *    brand a normal deposit as foreign.
 * 3. The filer belongs to several projects with no single owner role, so its
 *    "home" is genuinely ambiguous. A wrong badge is worse than none: a
 *    missing mark reads as ordinary, a false one sends the reader looking for
 *    a relationship that does not exist.
 */
export function originProjectFor(
    targetProject: string,
    subs: readonly OriginSubscription[],
): string | null {
    if (!targetProject || subs.length === 0) return null;
    if (subs.some((s) => s.project === targetProject)) return null;

    // The home project is where the filer is an owner. Exactly one owner is
    // the common case by far — an agent maintains one project and watches
    // others as a follower.
    const owned = subs.filter((s) => s.role === "owner");
    if (owned.length === 1) return owned[0].project;
    if (owned.length > 1) return null;

    // No owner role anywhere: a follower-only consumer. One subscription still
    // names its origin unambiguously; several do not.
    return subs.length === 1 ? subs[0].project : null;
}
