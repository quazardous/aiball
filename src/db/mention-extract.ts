// #1992 — pulling ticket references out of prose. PURE logic, extracted so it
// tests without a DB (same convention as landscape.ts / last-actor-gate.ts).
//
// WHY THIS EXISTS. aiball's typed relations are hand-curated, and measuring the
// corpus showed what that costs: on one project, 156 typed edges against 940
// pairs that were already written in plain prose — and 152 of those 156 were
// ALSO written in prose. Curation captured ~19% of what people had already
// said, and added 4 edges of its own. The graph isn't missing; it's unread.
//
// So this is a compiler front-end, not a curation tool. It only ever reports
// what a human already wrote, which is what lets every edge carry a citation
// back to the exact sentence.

/** One `#N` occurrence judged to be a ticket reference. */
export interface Mention {
    /** The referenced ticket id, as written. */
    ticketId: number;
    /** Byte offset of the `#` in the source text — the citation anchor. */
    offset: number;
}

/**
 * Below this, a `#N` is more often a pull-request or issue number than a
 * ticket. MEASURED, not guessed: on 10 965 corpus comments, three-digit-plus
 * refs surviving the noise guard were right 13 times out of 14 in a random
 * sample (~99.7% after the guard). Two-digit refs were roughly half wrong even
 * WITH the guard — "merger #43", "aiball#86", "`761fb8c` #10" are PR and commit
 * sequences, not tickets.
 *
 * The cost is the 99 tickets numbered under 100, all of them ancient. That
 * trade is deliberate: a missing edge is visible, a false edge is not.
 */
export const MIN_TICKET_REF = 100;

/** `#` followed by digits. Deliberately permissive — precision comes from the guard below. */
const REF = /#(\d+)\b/g;

/**
 * Words that, sitting immediately before a `#N`, mean it is NOT a ticket.
 * Every entry here was taken from a real false positive in the corpus rather
 * than imagined: "PR #326", "the real line #404", a bare github/gitlab URL.
 */
const NOISE_BEFORE =
    /(PR|pull request|issue|MR|merge request|github\.com\/\S*|gitlab\.com\/\S*|ligne|line|port|HTTP|status)\s*$/i;

/**
 * A `#N` GLUED to a path (`quazardous/aiball#86`, `gh:quazardous/aiball#86`)
 * is a repository reference, not a ticket. This is the precise mechanism for
 * URLs, and it catches the shorthand forms that carry no host at all — which a
 * word-based guard cannot, however wide its window.
 *
 * A genuine ref never matches: it is preceded by a space, `(` or `[`, and the
 * pattern is anchored at the `#`, so any whitespace between breaks it.
 */
const PATH_BEFORE = /[\w.-]+\/[\w.-]*$/;

/** How far back the guard looks. Wide enough to hold a host, still local. */
const GUARD_WINDOW = 48;

/**
 * Every ticket reference written in `text`, in order of appearance, including
 * repeats — the caller counts them (a pair mentioned once is often decoration;
 * twice or more is a real link) and keeps the first offset as the citation.
 *
 * This does NOT check that the ids exist: whether `#1819` is a ticket is a
 * question for the corpus, not for a regex. The caller intersects with the
 * known ids, which is also what keeps this function free of a DB.
 */
export function extractMentions(text: string | null | undefined): Mention[] {
    if (!text) return [];
    const out: Mention[] = [];
    REF.lastIndex = 0;
    for (let m = REF.exec(text); m !== null; m = REF.exec(text)) {
        const ticketId = Number(m[1]);
        if (!Number.isSafeInteger(ticketId) || ticketId < MIN_TICKET_REF) continue;
        const before = text.slice(Math.max(0, m.index - GUARD_WINDOW), m.index);
        if (NOISE_BEFORE.test(before) || PATH_BEFORE.test(before)) continue;
        out.push({ ticketId, offset: m.index });
    }
    return out;
}
