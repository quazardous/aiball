/** The sidecar a message carries (`messages.meta`, `tickets.meta`). */
import type { CommentDecision } from "./decisions.js";
import type { TypedRelationMeta } from "./relations.js";

export interface MessageMeta {
    /** Decision-on-comment sidecar (#B.129). Set by the author at post
     *  time (composer dropdown) and updated when the reporter accepts
     *  or rejects via the bus's message.decide. */
    decision?: CommentDecision;
    /** One-line agent-authored TLDR of the **thread state up to and
     *  including this comment** (#B.130). Not just this comment's body
     *  in isolation — david: "ça summarize tout jusqu'à là". Mandatory
     *  on comment_added since the same wording pass. Powers brief-mode
     *  reads. Settable at post-time via `summary_until` on the request
     *  body or retroactively via POST /api/messages/:id/summarize. */
    summary_until?: string;
    /** Typed inter-ticket relation payload (#B.123 phase B). Only set
     *  on rows with `kind = "ticket_relation"`. The relation's source
     *  ticket is the row's `ticket_id`; the target is encoded in
     *  meta.relation.target_ticket_id. Edits are append-only — to change
     *  a kind, post a new ticket_relation; to remove, post one with
     *  `kind = "ignored"` (or a tombstone — see relations.ts). */
    relation?: TypedRelationMeta;
    /** #309: user-deletion marker. Set when a human moderator deletes a
     *  comment from the UI. The row is soft-deleted (status flips to
     *  `rejected` so it's excluded everywhere — counts, gates, brief, MCP
     *  reads — exactly like a moderation reject), and this sidecar both
     *  records the audit (who/when) AND distinguishes a user-deletion from
     *  a moderation reject so the UI thread can render a tombstone for it
     *  (re-surfaced only with `?include_deleted=1`). */
    deleted?: { by: string; at: string };
    /** #518 (david `uzwfc3` MVP option A) — votes binaires +1/-1 sur les
     *  commentaires. Per-author (1 vote/consumer), retract-able en repostant
     *  la même value (toggle off) ou flip-able en postant l'autre. Stocké
     *  ici dans meta plutôt qu'en table dédiée pour éviter une migration
     *  v1 ; si plus tard on veut stats agrégées, on extrait vers
     *  `comment_votes`. La key est le consumer_id votant. */
    votes?: Record<string, 1 | -1>;
    /** #2331 — does this comment hand the ticket back? */
    handback?: boolean;
    /** #2308 — a step (`then: continue`). */
    step?: boolean;
    /** #2449 — when the step's author said it can resume (ISO). Absent: at once. */
    step_resume_at?: string;
    /** #2765 — the step also resumes when this ticket moves. */
    step_resume_on_ticket?: number;
    /** #4458 — the message whose pending decision this step withdrew. */
    step_withdrew?: number;
    /** #2369 — set when a human tagged this comment as a step after the fact:
     *  who, when, and the handback the comment carried, restored if the tag
     *  is removed. Absent on a step its author posted. */
    step_tagged?: { by: string; at: string; handback: boolean | null };
}

/**
 * Parse a possibly-null `meta` JSON string from the DB into a
 * `MessageMeta` object. Tolerates malformed JSON by returning `{}`
 * — meta is a sidecar, never the source of truth.
 */
export function parseMeta(raw: string | null | undefined): MessageMeta {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        return parsed as MessageMeta;
    } catch {
        return {};
    }
}

/**
 * Serialize a `MessageMeta` back to a string for DB storage. Returns
 * `null` when there's nothing worth persisting, so the column stays
 * NULL on empty rows.
 */
export function serializeMeta(meta: MessageMeta): string | null {
    const hasDecision = !!meta.decision;
    const hasSummary = typeof meta.summary_until === "string" && meta.summary_until.length > 0;
    const hasRelation = !!meta.relation;
    const hasDeleted = !!meta.deleted;
    if (!hasDecision && !hasSummary && !hasRelation && !hasDeleted) return null;
    return JSON.stringify(meta);
}
