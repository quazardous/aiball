/**
 * GFM task list = aiball question primitive (#B.104).
 *
 * Each `- [ ]` or `- [x]` line in a body becomes a "question" with a
 * stable id carried in an inline HTML comment marker:
 *
 *   - [ ]<!-- q:a3f2c1 --> Tu valides l'API change ?
 *   - [x]<!-- q:b7e891 --> Migration sur main ? → main
 *
 * The id is generated at message create/edit time so it survives
 * reorders and edits. The marker is invisible at render time
 * (DOMPurify drops HTML comments) but stays in the source body, so
 * the marker is the source of truth.
 *
 * The `[ ]` vs `[x]` character is the status — no separate state.
 * The optional `meta.questions[qid]` JSON sidecar (`messages.meta`,
 * `tickets.meta`) carries audit only: who toggled, when, in which
 * reply.
 *
 * This module is body-string-pure: no DB, no IO. The thin layer
 * that wires it to messages.ts and api.ts lives elsewhere.
 */
import { randomBytes } from "node:crypto";

export type QuestionStatus = "open" | "answered";

export interface Question {
    id: string;
    text: string;
    status: QuestionStatus;
    /** Zero-based line index in the body. Useful for the frontend's
     *  click target — it counts the Nth checkbox to find the same
     *  line. The id is the canonical handle though. */
    lineIdx: number;
}

export interface QuestionAnswer {
    answered_by: string;
    answered_at: string;
    answered_in: number;
}

import type { CommentDecision } from "./decisions.js";
import type { TypedRelationMeta } from "./relations.js";

export interface MessageMeta {
    questions?: Record<string, QuestionAnswer>;
    /** Decision-on-comment sidecar (#B.129). Set by the author at post
     *  time (composer dropdown) and updated when the reporter accepts
     *  or rejects via POST /api/messages/:id/decide. */
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
}

// `- [ ]` or `- [x]` line, optionally preceded by indent, optionally
// followed by the marker. Captures: 1=indent, 2=char, 3=marker-id or
// undefined, 4=trailing text after the marker.
//
// We also accept asterisks (`* [ ]`) and plus (`+ [ ]`) as GFM does.
//
// `\s*` between `]` and the marker so both the legacy no-space format
// (`- [ ]<!-- q:xxx -->`) and the GFM-friendly one (`- [ ] <!-- q:xxx -->`)
// parse. marked needs the space to recognize the line as a task-list
// item, so injectMarkers always emits the spaced form — but the read
// path tolerates either to avoid breaking existing bodies in the DB.
const TASK_LINE = /^([ \t]*)(?:[-*+])\s\[( |x|X)\](?:\s*<!--\s*q:([a-zA-Z0-9_-]+)\s*-->)?(.*)$/;

function newId(): string {
    // Just the hex — the `q:` namespace prefix lives in the marker
    // itself (`<!-- q:abc123 -->`), no need to embed it twice.
    return randomBytes(3).toString("hex");
}

/**
 * Scan the body line by line, extract task-list items as `Question`
 * entries. Lines without a marker get a synthetic id (`q-<random>`)
 * computed on the fly — call {@link injectMarkers} to persist those
 * ids back into the body so the same question always carries the
 * same id across edits.
 */
export function extractQuestions(body: string | null | undefined): Question[] {
    if (!body) return [];
    const out: Question[] = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = TASK_LINE.exec(lines[i]);
        if (!m) continue;
        const char = m[2].toLowerCase();
        const id = m[3] ?? newId();
        const trailing = (m[4] ?? "").trim();
        out.push({
            id,
            text: trailing,
            status: char === "x" ? "answered" : "open",
            lineIdx: i,
        });
    }
    return out;
}

/**
 * Walk the body and ensure every task-list line carries a stable
 * `<!-- q:xxx -->` marker. Existing markers are preserved; missing
 * ones are filled with a fresh random id. Returns the (possibly
 * rewritten) body. Idempotent.
 */
export function injectMarkers(body: string | null | undefined): string {
    if (!body) return body ?? "";
    const lines = body.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const m = TASK_LINE.exec(lines[i]);
        if (!m) continue;
        const indent = m[1];
        const char = m[2];
        const trailing = m[4] ?? "";
        const id = m[3] ?? newId();
        const trailingWithLeadingSpace = trailing.startsWith(" ") ? trailing : trailing ? " " + trailing : "";
        // Always emit the spaced form. marked's GFM task-list tokenizer
        // requires whitespace between `]` and the next content — without
        // it, the line renders as plain text instead of a checkbox. We
        // also rewrite legacy unspaced bodies on edit so they become
        // clickable next time the message round-trips through here.
        const rebuilt = `${indent}- [${char}] <!-- q:${id} -->${trailingWithLeadingSpace}`;
        // Note: we rewrite the bullet as `-` even if the source used
        // `*` or `+`. Style consistency over preservation; only fires
        // on task-list-shaped lines that need rewriting.
        if (lines[i] !== rebuilt) {
            lines[i] = rebuilt;
            changed = true;
        }
    }
    return changed ? lines.join("\n") : body;
}

/**
 * Toggle the `[ ]` ↔ `[x]` state on the task-list line carrying the
 * given question id. No-op when the id isn't found (defensive: a
 * stale frontend click on a deleted question shouldn't error).
 * Returns the new body and whether a change was made.
 *
 * `to` defaults to "answered" (the answer-on-reply flow); pass
 * "open" to explicitly reopen.
 */
export function setQuestionStatus(
    body: string | null | undefined,
    questionId: string,
    to: QuestionStatus = "answered",
): { body: string; changed: boolean } {
    if (!body) return { body: body ?? "", changed: false };
    const lines = body.split("\n");
    const targetChar = to === "answered" ? "x" : " ";
    for (let i = 0; i < lines.length; i++) {
        const m = TASK_LINE.exec(lines[i]);
        if (!m) continue;
        if (m[3] !== questionId) continue;
        const indent = m[1];
        const currentChar = m[2].toLowerCase();
        if (currentChar === targetChar.toLowerCase()) {
            return { body, changed: false }; // already in target state
        }
        const trailing = m[4] ?? "";
        const trailingWithLeadingSpace = trailing.startsWith(" ") ? trailing : trailing ? " " + trailing : "";
        // Spaced form between `]` and `<!--` so marked's GFM task-list
        // tokenizer renders the line as a checkbox (see injectMarkers).
        lines[i] = `${indent}- [${targetChar}] <!-- q:${questionId} -->${trailingWithLeadingSpace}`;
        return { body: lines.join("\n"), changed: true };
    }
    return { body, changed: false };
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
 * `null` when there's nothing worth persisting (no questions
 * answered, no other keys) so the column stays NULL on empty rows.
 */
export function serializeMeta(meta: MessageMeta): string | null {
    const hasQuestions = !!meta.questions && Object.keys(meta.questions).length > 0;
    const hasDecision = !!meta.decision;
    const hasSummary = typeof meta.summary_until === "string" && meta.summary_until.length > 0;
    const hasRelation = !!meta.relation;
    const hasDeleted = !!meta.deleted;
    if (!hasQuestions && !hasDecision && !hasSummary && !hasRelation && !hasDeleted) return null;
    return JSON.stringify(meta);
}
