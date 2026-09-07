// #2074 — pairing a proxy node: the rules, PURE so they test without a DB
// (same convention as landscape.ts / origin-project.ts).
//
// Today a node is enrolled by minting a token on the hub and carrying it to the
// node by hand. The tiring part isn't the command, it's moving a 48-hex secret
// between two machines — and it exists in the clear on both for the duration.
// There is also no explicit approval: whoever holds the token IS a node, and
// `docs/SECURITY.md` calls that the weak point of the whole system, since a node
// token can impersonate any consumer.
//
// So the node asks, and a human approves. Which means the request necessarily
// arrives UNAUTHENTICATED — the node has no credential yet, that is the entire
// point. Three rules make that door narrow, and they live here:
//
//   1. A request never mints anything. It records an intent, and the token is
//      created by the same authority as before: a human clicking approve.
//   2. The short code protects the HUMAN, not the door. It doesn't stop anyone
//      knocking; it guarantees the row being approved is the machine in front
//      of you rather than someone else's that arrived at the same moment.
//   3. The door closes on its own — a request expires, and an approved token is
//      collected once.

import { randomInt } from "node:crypto";

/**
 * Alphabet for the pairing code: no I, L, O, U, 0, 1. The first four are read
 * back wrongly over a phone or across a desk, and the code exists precisely to
 * be compared out loud between two screens. U is dropped so the generator
 * cannot spell something unfortunate.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** How long a request stays claimable. Short: it is typed and approved in the
 *  same minute, and an unattended one should stop being a door. */
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/**
 * #2079 — how long an expired request stays VISIBLE after it stopped being a
 * door. Two different things: the ten minutes above are how long the request
 * can be approved, this is how long a human can still learn that it happened.
 *
 * Dropping it the instant it expired was silent in the worst way — the request
 * exists precisely because someone isn't at the screen, so the case where it
 * expires unseen is the normal one, not the edge one. Half a day means someone
 * pairing in the morning still sees it after lunch, and the row says what to do
 * about it: ask again from the node.
 */
export const ENROLLMENT_RETENTION_MS = 12 * 60 * 60 * 1000;

/** Whether a request is old enough to stop being shown at all. */
export function isForgettable(row: EnrollmentRow, nowMs: number): boolean {
    return enrollmentState(row, nowMs) === "expired"
        && Date.parse(row.expires_at) <= nowMs - ENROLLMENT_RETENTION_MS;
}

/**
 * A code a human can compare at a glance: `K7F-M92`. Grouped because an
 * ungrouped run of six is read wrong far more often than two runs of three.
 */
export function makePairingCode(): string {
    const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
}

/** The stored shape this reasons about — nothing more. */
export interface EnrollmentRow {
    status: string;
    expires_at: string;
    delivered_at?: string | null;
}

export type EnrollmentState =
    /** Waiting for a human. Shown in the Nodes panel. */
    | "pending"
    /** Nobody approved it in time. Not a door any more. */
    | "expired"
    /** Approved; the node may collect its token. */
    | "approved"
    /** The token has been collected. Nothing further is served. */
    | "delivered"
    /** A human said no. */
    | "rejected";

/**
 * What a request currently is. Expiry beats `pending`, and ONLY `pending` — an
 * approval already granted stays collectable, because the human has decided and
 * a node briefly slow to poll shouldn't have to ask again.
 */
export function enrollmentState(row: EnrollmentRow, nowMs: number): EnrollmentState {
    if (row.status === "rejected") return "rejected";
    if (row.delivered_at) return "delivered";
    if (row.status === "approved") return "approved";
    return Date.parse(row.expires_at) <= nowMs ? "expired" : "pending";
}

/** Whether a human may still act on this request. */
export function isDecidable(row: EnrollmentRow, nowMs: number): boolean {
    return enrollmentState(row, nowMs) === "pending";
}

/** Whether the node may still collect a token from this request. */
export function isCollectable(row: EnrollmentRow, nowMs: number): boolean {
    return enrollmentState(row, nowMs) === "approved";
}
