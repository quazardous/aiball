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

export interface MessageMeta {
    questions?: Record<string, QuestionAnswer>;
    /** Decision-on-comment sidecar (#B.129). Set by the author at post
     *  time (composer dropdown) and updated when the reporter accepts
     *  or rejects via POST /api/messages/:id/decide. */
    decision?: CommentDecision;
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
    if (!hasQuestions && !hasDecision) return null;
    return JSON.stringify(meta);
}
