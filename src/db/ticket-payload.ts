// #2109 — the rules of a ticket's payload zone, PURE so they test without a DB
// (same convention as node-enrollment.ts / last-actor-gate.ts).
//
// david: « il faudrait la possibilité d'avoir des ticket technique dont des
// ticket avec secret », then, better: « une zone payload pour les ticket (pas
// utilisé en général mais utile) ». A zone on an ordinary ticket, not a class
// of ticket — which is what makes the whole feature cost nothing to the tickets
// that don't use it.
//
// Two rules carry the design, and both are inversions worth stating:
//
//   1. The schema lists the keys that are PUBLIC, never the secret ones. So
//      "no schema => everything is secret" is not a branch anyone codes; it is
//      what an empty list already means. The unsafe configuration is the one
//      you have to type out.
//   2. Filtering happens on the way OUT of storage, once, rather than at each
//      call site. A redaction that every reader must remember to apply is a
//      redaction that holds until the first reader who forgets.
//
// What this buys, said honestly: not protection from an agent that misbehaves —
// one that can USE a key can already do everything the key permits. It prevents
// the ACCIDENTAL exposure, which is the realistic way a credential leaks here:
// into a transcript, a log, a ticket dump, a commit.

/** Characters of a secret shown as a preview. Fixed and small — never a
 *  fraction of the value, or a short secret would reveal itself in proportion
 *  to how little of it there is. */
export const SECRET_PREVIEW_CHARS = 4;

/**
 * Shortest secret that gets a preview at all. Below this, showing even four
 * characters gives away a third of the value, so the preview is dropped and
 * only the key remains. A preview exists to let a human recognise WHICH key
 * they are looking at (`sk-a…` vs `ghp_…`), not to transmit any of it.
 */
export const SECRET_PREVIEW_MIN_LENGTH = 12;

/** A secret value, as everything except the deliberate dump path sees it. */
export type RedactedValue = {
    secret: true;
    /** First few characters, or null when the value is too short to preview. */
    preview: string | null;
};

export type FilteredPayload = Record<string, unknown>;

/** True for the shape `filterPayload` substitutes in place of a secret. */
export function isRedacted(v: unknown): v is RedactedValue {
    return typeof v === "object" && v !== null && (v as { secret?: unknown }).secret === true;
}

/**
 * The declared-public key list.
 *
 * Anything that isn't a JSON array of strings — absent, null, malformed, an
 * object, a number — yields an EMPTY list, i.e. everything secret. Parsing
 * failures have to fall to the safe side: a corrupted schema column must not be
 * a way to publish a payload.
 */
export function parsePublicKeys(schema: string | null | undefined): string[] {
    if (!schema) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(schema);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string");
}

/** The redacted stand-in for one secret value. */
export function redactValue(value: unknown): RedactedValue {
    if (typeof value !== "string" || value.length < SECRET_PREVIEW_MIN_LENGTH) {
        return { secret: true, preview: null };
    }
    return { secret: true, preview: value.slice(0, SECRET_PREVIEW_CHARS) };
}

/**
 * The projection every surface gets: API, MCP, UI, exports.
 *
 * KEYS ARE ALWAYS VISIBLE — that is the point of the design rather than an
 * oversight. A payload nobody can see the shape of is an object nobody can
 * audit, and david's rule ("un dump n'afficherait que les clés") is what keeps
 * an unreadable secret from also becoming an invisible one. It follows that a
 * key NAME must never carry the secret.
 */
export function filterPayload(
    payload: Record<string, unknown>,
    publicKeys: readonly string[],
): FilteredPayload {
    const isPublic = new Set(publicKeys);
    const out: FilteredPayload = {};
    for (const [key, value] of Object.entries(payload)) {
        out[key] = isPublic.has(key) ? value : redactValue(value);
    }
    return out;
}

/**
 * Who may read the raw values — david: « seul le owner/assignee/reporter
 * peuvent voir un secret ».
 *
 * `claimant` is ABSENT from this predicate, and that is the load-bearing part
 * rather than an omission. Since #436 claim and assignment are two distinct
 * columns with two distinct doors: pushing `assignee` onto someone else is
 * moderator-only (403 in api/tickets.ts), while ANY agent can claim any
 * approved ticket for itself. Reading `claimant` here would therefore let any
 * agent open the vault by claiming the ticket first.
 *
 * The same asymmetry is what answers "who may consume?" without a new ACL: for
 * an agent to read a secret it did not deposit, a human has to assign the
 * ticket to it. The assignment IS the grant.
 *
 * Note for whoever extends this: `claude-loop/wake-context.ts` carries a
 * `claimant === me || assignee === me || mentionsMe` predicate. It is correct
 * where it lives (deciding what to say in a wake) and must not be reused here.
 */
export function canReadPayloadSecrets(
    ticket: { by_agent?: string | null; assignee?: string | null },
    consumerId: string,
    consumerIsHuman: boolean,
): boolean {
    if (consumerIsHuman) return true; // owner / moderator
    if (!consumerId) return false;
    if (ticket.by_agent === consumerId) return true; // reporter — it deposited
    return ticket.assignee === consumerId; // assignee — a human handed it over
}

/**
 * Whether the zone still hands anything back.
 *
 * Closing the ticket ends access: the payload's lifetime is the work's
 * lifetime, which is the whole reason for hanging a vault off a ticket rather
 * than administering one. Revocation is checked first because it is the
 * stronger statement — a revoked payload has no values left to hand back at
 * all, whereas a closed one is merely out of reach until reopened.
 */
export function payloadAccessState(
    ticket: { closed?: boolean | number | null },
    row: { revoked_at?: string | null },
): "open" | "revoked" | "ticket-closed" {
    if (row.revoked_at) return "revoked";
    return ticket.closed ? "ticket-closed" : "open";
}
