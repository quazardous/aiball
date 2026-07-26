/**
 * #1566 — watch a coupled issue, don't mirror it.
 *
 * David's correction, mid-design: *« le but est de coupler un issue avec un
 * ticket, pas forcément de dupliquer l'info »*. The earlier plan copied title,
 * body, state and labels down on a timer — and every hard problem it created
 * (conflict policy, which side wins, the pre-edit archive, churn suppression)
 * was a child of the COPY, not of the coupling. Remove the copy and they all
 * disappear.
 *
 * So this module never writes a ticket field. It answers one question — *did
 * anything move over there?* — and when the answer is yes, it says so in the
 * thread with one comment. The excerpt it quotes comes from the response of
 * the moment and is used, not stored.
 *
 * ## The watermark
 *
 * `tickets.upstream_seen_at` holds the remote's own `updated_at` as last seen.
 * A newer one means something changed; nothing else is needed to detect it, and
 * a timestamp is not a copy of anything.
 *
 * An outgoing push (the editorial gesture, #1570) advances the same watermark,
 * which is what stops our own writes from coming back as "updated upstream".
 * Filtering the echo by *recognising* our comments would have required fetching
 * them — exactly the duplication this design refuses.
 *
 * ## Who speaks
 *
 * `__system:upstream` (david `y9r234`). The `__system:` prefix is self-marking,
 * so any listing that must exclude machine identities tests the prefix instead
 * of maintaining a registry. It is NOT null: the thread renders `by {agent}`
 * behind a `v-if`, so a null author would appear as no author at all — invisible
 * where the whole point is to read as "this came from the machine".
 */
import type { ExternalIssue } from "./upstream-providers.js";

/** The `__system:` namespace marks an identity nothing human or agent owns. */
export const SYSTEM_PREFIX = "__system:";
export const UPSTREAM_ACTOR = `${SYSTEM_PREFIX}upstream`;

/** True for any machine identity. One string test, no registry to keep in sync. */
export function isSystemActor(consumerId: string | null | undefined): boolean {
    return !!consumerId && consumerId.startsWith(SYSTEM_PREFIX);
}

export interface WatchState {
    /** Remote `updated_at` as last observed. NULL = never observed. */
    seenAt: string | null;
}

export type WatchDecision =
    /** Nothing moved — write nothing at all, not even a no-op event. */
    | { kind: "unchanged" }
    /** First observation: adopt the watermark WITHOUT announcing anything. */
    | { kind: "adopt"; seenAt: string }
    /** Something moved since the watermark. */
    | { kind: "changed"; seenAt: string };

/**
 * PURE — compare the remote's `updated_at` to our watermark.
 *
 * The `adopt` case matters: on the very first probe of a ticket coupled long
 * ago, everything looks "new" because we never had a watermark. Announcing
 * would spam every coupled ticket at once the day this ships, for changes
 * nobody is waiting to hear about. So the first observation is silent and only
 * arms the watermark.
 *
 * Timestamps compare lexicographically because ISO-8601 UTC sorts that way; a
 * malformed or missing remote value yields `unchanged` rather than a guess —
 * announcing on garbage would be worse than staying quiet.
 */
export function decideWatch(state: WatchState, external: ExternalIssue): WatchDecision {
    const remote = external.updatedAt;
    if (typeof remote !== "string" || !remote) return { kind: "unchanged" };
    if (!state.seenAt) return { kind: "adopt", seenAt: remote };
    if (remote <= state.seenAt) return { kind: "unchanged" };
    return { kind: "changed", seenAt: remote };
}

/** Collapse whitespace and clip, so a quoted excerpt stays one readable line. */
export function excerpt(text: string | null | undefined, max = 160): string {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    if (!flat) return "";
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * PURE — the notice posted in the thread.
 *
 * Deliberately short: it is a pointer, not a mirror. It says what kind of
 * change happened, quotes just enough to decide whether to go look, and links
 * out. `closedBy` rides along for free in the issue payload, so a closure can
 * name whoever did it without a second call — while a plain edit names nobody
 * rather than inventing an attribution.
 */
export function formatUpstreamNotice(ref: string, external: ExternalIssue): string {
    const who = external.closedBy ? ` by **${external.closedBy}**` : "";
    const head = external.state === "closed"
        ? `**Updated upstream** — \`${ref}\` was **closed**${who}.`
        : `**Updated upstream** — \`${ref}\` changed.`;
    const quoted = excerpt(external.title);
    const lines = [head];
    if (quoted) lines.push(`> ${quoted}`);
    if (external.url) lines.push(`→ ${external.url}`);
    // No decision, no summary_until: this is a signal, not a position. It is
    // the ticket becoming actionable again that carries the meaning.
    return lines.join("\n\n");
}
