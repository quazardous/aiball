/** #3063 — messages: one read, and the gestures on a comment or a ticket event. */
import { z } from "zod";
import { authorOf, consumerIdOf, defineMethod, Refusal, refusalFrom } from "../methods.js";
import { id } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import {
    deleteComment,
    deletePingsForMessage,
    getMessage,
    markQuestionAnswered,
    noteMessage,
    promoteMessageToDecision,
    reclassifyMessageDecision,
    removeMessageDecision,
    setMessageSummary,
    setMessageVote,
    type Message,
} from "../../db.js";
import { clearSeenForMessage, insertPing } from "../../db/pings.js";
import { isDecisionKind } from "../../decisions.js";
import { broadcast } from "../../ws.js";
import { resolveAttachments } from "../../db/uploads.js";
import { withTagsOne, withVotesOne } from "../../api/_helpers.js";

const MODERATOR = (what: string) => ({
    who: ["human"] as const,
    denied: { message: what, code: ERROR_CODES.MODERATOR_ONLY },
});

/** One message, with its tags and the uploads its text cites (#3040). */
defineMethod({
    name: "message.get",
    who: ["human", "agent"],
    params: z.object({ id }),
    run: (caller, p) => {
        const m = getMessage(p.id);
        if (!m) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return { ...withTagsOne(m), attachments: resolveAttachments([m.body], caller.transport === "uds") };
    },
});

/** The message `id` names, or a 404. */
function messageOf(messageId: number): Message {
    const m = getMessage(messageId);
    if (!m) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
    return m;
}

/** A message changed: its tags joined, and the live clients told. */
function edited(m: Message, type: "message_edited" | "message_noted" = "message_edited") {
    const decorated = withTagsOne(m);
    broadcast({ type, data: decorated });
    return decorated;
}

/** A write in the store refused as a conflict (409), with its own code when it has one. */
function conflictOf<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof Refusal) throw e;
        throw refusalFrom(409, e);
    }
}

/**
 * Delete a comment (#309), a human's gesture. A soft delete: gone from counts,
 * gates and reads, shown as a tombstone to a thread read that asks for it.
 * Pings are wiped. A comment carrying a finalized decision is refused.
 */
defineMethod({
    name: "message.delete",
    who: ["human", "agent"],
    params: z.object({ id }),
    run: (caller, p) => {
        const existing = messageOf(p.id);
        if (existing.kind !== "comment_added") throw new Refusal(400, "only comments can be deleted");
        if (caller.kind !== "human") {
            throw new Refusal(403, "only a registered human moderator can delete a comment", ERROR_CODES.MODERATOR_ONLY);
        }
        let updated: Message | null;
        try {
            updated = deleteComment(p.id, consumerIdOf(caller));
        } catch (e) {
            throw new Refusal(400, (e as Error).message);
        }
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        deletePingsForMessage(p.id);
        return edited(updated);
    },
});

/**
 * Mark a question of a message answered (#B.104): its checkbox ticked, the
 * audit in `meta.questions`. Idempotent. #3036 — who answers is the caller.
 */
defineMethod({
    name: "message.answer_question",
    who: ["human", "agent"],
    params: z.object({ id, qid: z.string(), answered_by: z.unknown().optional(), answered_in: z.unknown().optional() }),
    run: (caller, p) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(p.qid)) throw new Refusal(400, "invalid question id");
        const answeredBy = authorOf(caller, p.answered_by, "answered_by");
        const answeredIn = p.answered_in;
        if (typeof answeredIn !== "number" || !Number.isFinite(answeredIn)) throw new Refusal(400, "answered_in (number) required");
        const updated = markQuestionAnswered(p.id, p.qid, { answered_by: answeredBy, answered_at: new Date().toISOString(), answered_in: answeredIn });
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated);
    },
});

/**
 * #827 — resurface a message: its pings unseen again, so the recipients see
 * it at their next wake. A human's gesture: an agent must not fabricate unread.
 */
defineMethod({
    name: "message.resurface",
    ...MODERATOR("only a registered human moderator can resurface a message"),
    params: z.object({ id }),
    run: (_c, p) => {
        const existing = messageOf(p.id);
        const { resurfaced } = clearSeenForMessage(p.id);
        broadcast({ type: "message_edited", data: withTagsOne(existing) });
        return { resurfaced };
    },
});

/** Set a comment's one-line summary (#B.130); an empty string clears it. */
defineMethod({
    name: "message.summarize",
    who: ["human", "agent"],
    params: z.object({ id, summary: z.unknown().optional() }),
    run: (_c, p) => {
        if (typeof p.summary !== "string") throw new Refusal(400, "summary (string) required");
        const summary = p.summary;
        const updated = conflictOf(() => setMessageSummary(p.id, summary));
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated);
    },
});

/**
 * #518 — vote on a comment: 1, -1, or 0 to take one's vote back. #749 — a
 * thumb up pings the comment's author.
 */
defineMethod({
    name: "message.vote",
    who: ["human", "agent"],
    params: z.object({ id, value: z.unknown().optional() }),
    run: (caller, p) => {
        const value = p.value;
        if (value !== 1 && value !== -1 && value !== 0) throw new Refusal(400, "value must be 1, -1, or 0");
        const voter = consumerIdOf(caller);
        const updated = conflictOf(() => setMessageVote(p.id, voter, value));
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        const decorated = withVotesOne(withTagsOne(updated), voter);
        broadcast({ type: "message_edited", data: decorated });
        if (value === 1 && updated.by_agent && updated.by_agent !== voter) insertPing(updated.by_agent, updated, voter);
        return decorated;
    },
});

/** Swap a pending decision's kind (plan / resolution…) without deciding it. */
defineMethod({
    name: "message.reclassify",
    who: ["human", "agent"],
    params: z.object({ id, new_kind: z.unknown().optional() }),
    run: (_c, p) => {
        const kind = p.new_kind;
        if (typeof kind !== "string" || !isDecisionKind(kind)) throw new Refusal(400, "new_kind must be a valid decision kind");
        const updated = conflictOf(() => reclassifyMessageDecision(p.id, kind));
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated);
    },
});

/**
 * #B.256 — make a comment a decision: pending with `kind` alone, or decided
 * at once with `status` accepted / rejected.
 */
defineMethod({
    name: "message.promote",
    who: ["human", "agent"],
    params: z.object({ id, kind: z.unknown().optional(), status: z.unknown().optional() }),
    run: (caller, p) => {
        const kind = p.kind;
        if (typeof kind !== "string" || !isDecisionKind(kind)) throw new Refusal(400, "kind must be a valid decision kind");
        let status: "accepted" | "rejected" | undefined;
        if (p.status !== undefined && p.status !== null) {
            if (p.status !== "accepted" && p.status !== "rejected") throw new Refusal(400, "status must be accepted or rejected (omit for pending)");
            status = p.status;
        }
        const updated = conflictOf(() => promoteMessageToDecision(p.id, kind, status, consumerIdOf(caller)));
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated);
    },
});

/** Clear a comment's pending decision (#B.256); a decided one keeps its audit. */
defineMethod({
    name: "message.untag",
    who: ["human", "agent"],
    params: z.object({ id }),
    run: (_c, p) => {
        const updated = conflictOf(() => removeMessageDecision(p.id));
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated);
    },
});

/** A moderation note on a message; anything but a string clears it. */
defineMethod({
    name: "message.note",
    who: ["human", "agent"],
    params: z.object({ id, note: z.unknown().optional() }),
    run: (_c, p) => {
        const updated = noteMessage(p.id, typeof p.note === "string" ? p.note : null);
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        return edited(updated, "message_noted");
    },
});
