/** #3063 — messages: one read, and the gestures on a comment or a ticket event. */
import { z } from "zod";
import { moderationRefusal } from "../../moderation-gate.js";
import { isMachineLocal } from "../../machine-secret.js";
import { authorOf, consumerIdOf, defineMethod, Refusal, refusalFrom } from "../methods.js";
import { id } from "../params.js";
import { ERROR_CODES, MESSAGE_SCOPES, TICKET_LEVELS, type TicketLevel } from "../../domain.js";
import { deliverToOutbox } from "../../outbox.js";
import { type MessageKind, applyMessageDecision } from "../../db.js";
import { decisionGesture } from "../../ticket-transitions.js";
import { type DecisionKind } from "../../decisions.js";
import { earnOnClose } from "../../db/wait-credit.js";
import { getInboxAgg } from "../../db/inbox-agg.js";
import { milestoneOpenRefusal, openTicketsIn } from "../../db/milestones.js";
import { emitLifecycle } from "../../event-bus.js";
import { fanOutPings, notifyDecision } from "../../notifications.js";
import { seesLevel } from "../../db/consumers.js";
import {
    deleteComment,
    deletePingsForMessage,
    editMessage,
    getMessage,
    INTENTS,
    isHuman,
    PRIORITIES,
    updateMessageStatus,
    type Intent,
    type Priority,
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
import { commitsRequirement, creationHandbackFor, isDecisionEventKind, submitMessage, validateNewMessage, withoutDecisionRefusal } from "../../messages.js";
import { NO_EXTRAS, fileTicket, isExtrasRefusal, ticketExtras, SUBMIT_REFUSAL_STATUS } from "../../file-ticket.js";
import { applyPlatformTag } from "./message-filing.js";
import { applyModeration } from "./moderation.js";
import { tagMessageAsStep, untagMessageStep } from "../../db/messages.js";
import { broadcast } from "../../ws.js";
import { ticketMoved } from "./subjects.js";
import { resolveAttachments } from "../../db/uploads.js";
import { withTagsOne, withVotesOne } from "../../queries/decorate.js";
import { isIdempotencyKey, keyedMessage, rememberKey } from "../../db/idempotency.js";

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
        return { ...withTagsOne(m), attachments: resolveAttachments([m.body], isMachineLocal(caller)) };
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

/**
 * #3252 — a post on a ticket belongs to the ticket's project: the daemon reads
 * it, a client need not send it, and a project that says otherwise is not kept.
 */
function onItsTicket(p: Record<string, unknown>): Record<string, unknown> {
    if (p.kind === "ticket_created" || typeof p.ticket_id !== "number") return p;
    const ticket = getMessage(p.ticket_id);
    if (!ticket || ticket.kind !== "ticket_created") {
        throw new Refusal(404, `ticket #${p.ticket_id} does not exist`, ERROR_CODES.TICKET_NOT_FOUND);
    }
    return { ...p, project: ticket.project };
}

/**
 * Post a message: a ticket (with its extras, #3037), a comment, a decision or
 * a lifecycle event. #3036 — the author is the caller. #830 — the decision
 * events (plan_accepted…) are the daemon's own: `message.decide` makes them.
 * The params are the message itself, as HTTP's body.
 */
defineMethod({
    name: "message.post",
    who: ["human", "agent"],
    params: z.looseObject({ by_agent: z.unknown().optional() }),
    run: (caller, p) => {
    // #3036 — the author IS the caller: a body naming someone else is refused.
    // Settled BEFORE validation, which judges "human or agent" (summary_until…)
    // on the author: judged on the body, a human leaving by_agent out was
    // taken for an agent.
    const author = authorOf(caller, p.by_agent);
    // #3245 — the same write sent again (its answer was lost, the client's
    // spool replays it): answered with the message it made, never a second.
    const key = isIdempotencyKey(p.idempotency_key) ? p.idempotency_key : null;
    if (key) {
        const made = keyedMessage(key, author);
        const prior = made !== null ? getMessage(made) : null;
        if (prior) return { ...withTagsOne(prior), replayed: true };
    }
    const v = validateNewMessage(onItsTicket(p), author);
    if ("error" in v) throw new Refusal(400, v.error, v.code);
    // #830 — decision-event kinds (plan_accepted / plan_rejected / …) are
    // emitted server-side by the /decide handler ONLY. External callers
    // can't fabricate them: a real accept/reject must flow through the
    // decision validation pipeline (gates by-status, applies the meta
    // flip atomically). Reject any direct POST with one of these kinds.
    if (isDecisionEventKind(v.kind)) {
        throw new Refusal(400, `kind ${v.kind} is server-emitted only — use message.decide to accept or reject a decision`);
    }
    // #595 — auto-fill by_agent from the auth context when the caller omits
    // it. The bulk-close UI in App.vue calls POST /messages without by_agent
    // and `submitMessage` then can't run `assertCloseAuthority` properly
    // (no consumer to compare to the ticket reporter, no isHuman bypass) —
    // every close on a ticket the moderator didn't open returned 403. Same
    // pattern as api/tickets.ts:assign which has always done `consumerOf(req)`.
    v.by_agent = author;
    // #2275 / #2331 — an agent's comment carries a then, or says whether it hands the ticket back.
    const noDecision = withoutDecisionRefusal(v, author);
    if (noDecision) throw new Refusal(400, noDecision.error, noDecision.code);
    // #2652 — an agent's comment says which commits it delivers, or that it delivers none.
    const commitsRule = commitsRequirement(v, author, (caller.client_features ?? []).includes("commits"));
    if (commitsRule.refusal) throw new Refusal(400, commitsRule.refusal, ERROR_CODES.COMMITS_REQUIRED);
    // #2331 — a project's lead filing a ticket without a plan is reminded, not refused.
    const warning = v.kind === "ticket_created" ? creationHandbackFor(v).warning : commitsRule.warning;
    // #3037 — a new ticket comes with its extras (tags, assignee, milestone,
    // level), all checked before anything is written.
    const extras = v.kind === "ticket_created" ? ticketExtras(p, v.project, author) : NO_EXTRAS;
    if (isExtrasRefusal(extras)) throw new Refusal(extras.status, extras.error, extras.code);
    try {
        const msg = v.kind === "ticket_created" ? fileTicket(v, extras, author) : submitMessage(v);
        applyPlatformTag(msg, caller.platform ?? null);
        if (key) rememberKey(key, author, msg.id);
        return { ...withTagsOne(msg), ...(warning ? { warnings: [warning] } : {}) };
    } catch (err) {
        const status = SUBMIT_REFUSAL_STATUS[(err as { code?: string }).code ?? ""];
        if (status) throw refusalFrom(status, err);
        throw err;
    }
    },
});

/**
 * Moderate a pending message: approve or reject it (#2180 — the ripple, the
 * same one the pending-children sweep applies, lives in ./moderation.ts).
 */
for (const [name, status] of [["message.approve", "approved"], ["message.reject", "rejected"]] as const) {
    defineMethod({
        name,
        who: ["human", "agent"],
        params: z.object({ id }),
        run: (caller, p) => {
            const existing = messageOf(p.id);
            if (existing.status !== "pending") {
                throw new Refusal(400, `message already ${existing.status}`, ERROR_CODES.ALREADY_MODERATED);
            }
            const decorated = applyModeration(existing, status, consumerIdOf(caller));
            if (!decorated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
            return decorated;
        },
    });
}

/**
 * #2369 — tag an agent's comment as a step (`then: continue`) the agent did not
 * post, or remove that tag. A human's gesture. Silent: no ping — the agent
 * finds the ticket back in its pool at its next wake.
 */
for (const [name, tag] of [["message.step", true], ["message.unstep", false]] as const) {
    defineMethod({
        name,
        ...MODERATOR("only a registered human moderator can tag a comment as a step"),
        params: z.object({ id }),
        run: (caller, p) => {
            const existing = messageOf(p.id);
            if (tag && (!existing.by_agent || isHuman(existing.by_agent))) {
                throw new Refusal(409, "only an agent's comment can be tagged as a step");
            }
            const updated = conflictOf(() => (tag ? tagMessageAsStep(p.id, consumerIdOf(caller)) : untagMessageStep(p.id)));
            if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
            return edited(updated);
        },
    });
}

/**
 * #3195 — a proposal (plan, resolution, wontfix, escalation) is decided only on
 * a ticket the moderator has approved, as one is posted only there: until
 * then the ticket itself is what is pending. A ticket filed with its plan is
 * that proposal, so its own status counts.
 */
function refuseWhileTicketAwaitsModeration(messageId: number): void {
    const m = getMessage(messageId);
    if (!m) return;
    const ticket = m.kind === "ticket_created" ? m : m.ticket_id != null ? getMessage(m.ticket_id) : null;
    const refusal = ticket ? moderationRefusal("decide", ticket, { human: false }) : null; // #3249
    if (refusal) throw new Refusal(refusal.status, refusal.error, refusal.code);
}

/**
 * #618 — accept a pending resolution and close its ticket in one gesture, so
 * no client sees the state in between. The close pings no one: the accepted
 * decision already did (#921). Not one transaction: when the close fails
 * after the accept, the refusal (500) carries the accepted decision.
 */
defineMethod({
    name: "message.accept_and_close",
    who: ["human", "agent"],
    params: z.object({ id, body: z.unknown().optional() }),
    run: (caller, p) => {
    const id = p.id;
    const existing = getMessage(id);
    if (!existing) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
    if (existing.status !== "pending") {
        throw new Refusal(400, `message already ${existing.status}`, ERROR_CODES.ALREADY_MODERATED);
    }
    if (!existing.ticket_id) {
        throw new Refusal(400, "message has no parent ticket to close");
    }
    refuseWhileTicketAwaitsModeration(id);
    // Step 1 : approve the pending decision message. Inline mirror of
    // message.approve minus its answer — we want to ship
    // the combined response below.
    const approved = updateMessageStatus(id, "approved", "human", null, existing.kind);
    if (!approved) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
    const approvedDecorated = withTagsOne(approved);
    deliverToOutbox(approved);
    fanOutPings(approved);
    notifyDecision(approved, consumerIdOf(caller));
    broadcast({ type: "message_decided", data: approvedDecorated });
    emitLifecycle({ op: "decided", message: approvedDecorated });
    // No status_changed emit : that hook fires only for ticket_created
    // status flips ; this is a comment-with-decision approval.
    // Step 2 : insert the ticket_closed event. submitMessage handles its
    // own broadcasts + close-time cleanup (autoApproveStaleDecisionsOnClose
    // etc) inside its existing path.
    const byAgent = consumerIdOf(caller);
    const body = typeof p.body === "string" ? p.body : undefined;
    try {
        // #921 — skip ping fan-out : la décision d'acceptance ci-dessus
        // a déjà pingé tous les consumers concernés (resolution_accepted).
        // Le ticket_closed auto-émis qui suit est redondant côté ping
        // (mêmes consumers, info équivalente). Les broadcasts + lifecycle
        // emits restent (UI list / thread doivent voir le close).
        const closeMsg = submitMessage({
            project: approved.project,
            kind: "ticket_closed",
            ticket_id: existing.ticket_id,
            parent_id: existing.ticket_id,
            body,
            by_agent: byAgent,
        }, { skipFanOut: true });
        return {
            approved: approvedDecorated,
            closed: withTagsOne(closeMsg),
        };
    } catch (err) {
        if ((err as { code?: string }).code === ERROR_CODES.FORBIDDEN_CLOSE) throw refusalFrom(403, err);
        // The approve already landed ; we surface the close error so the
        // client knows to refresh + retry the close manually.
        // The accepted decision rides in `details.approved`.
        throw new Refusal(500, `accepted resolution but failed to close: ${(err as Error).message}`, ERROR_CODES.INTERNAL, { approved: approvedDecorated });
    }
    },
});

/**
 * Edit a message: title, body, summary, intent, priority, scope, and a
 * ticket's level (#2216 — a human's gesture: an agent could drop a ticket out
 * of every coder's queue). #509 — a priority that moved fires
 * `priority_changed`; #2241 — a level its holder does not work on says so.
 */
defineMethod({
    name: "message.edit",
    who: ["human", "agent"],
    params: z.object({
        id,
        title: z.any().optional(),
        body: z.any().optional(),
        summary: z.any().optional(),
        intent: z.any().optional(),
        priority: z.any().optional(),
        scope: z.any().optional(),
        level: z.any().optional(),
    }),
    run: (caller, p) => {
    const id = p.id;
    const existing = getMessage(id);
    if (!existing) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
    const { title, body, summary, intent, priority, scope, level } = p;
    if (
        title === undefined &&
        body === undefined &&
        summary === undefined &&
        intent === undefined &&
        priority === undefined &&
        scope === undefined &&
        level === undefined
    ) {
        throw new Refusal(400, "provide title, body, summary, intent, priority, scope, and/or level");
    }
    // #1565 — `title` is the ticket's real column (NOT NULL), no longer an
    // overlay that null could clear. Reject rather than 500 at the DB layer.
    if (title !== undefined && typeof title !== "string") {
        throw new Refusal(400, "title must be a string");
    }
    if (intent !== undefined && intent !== null) {
        if (typeof intent !== "string" || !INTENTS.includes(intent as Intent)) {
            throw new Refusal(400, `intent must be one of ${INTENTS.join(", ")}`);
        }
    }
    if (priority !== undefined && priority !== null) {
        if (typeof priority !== "string" || !PRIORITIES.includes(priority as Priority)) {
            throw new Refusal(400, `priority must be one of ${PRIORITIES.join(", ")}`);
        }
    }
    // #553 — scope is the #B.245 tristate.
    if (scope !== undefined && scope !== null) {
        if (typeof scope !== "string" || !(MESSAGE_SCOPES as readonly string[]).includes(scope)) {
            throw new Refusal(400, `scope must be one of ${MESSAGE_SCOPES.join(", ")}`);
        }
    }
    // #2216/#2241 — a ticket's level decides whose backlog and notifications it
    // reaches, so a human sets it: an agent able to move a ticket to another level
    // could drop it out of every coder's queue.
    if (level !== undefined) {
        if (typeof level !== "string" || !(TICKET_LEVELS as readonly string[]).includes(level)) {
            throw new Refusal(400, `level must be one of ${TICKET_LEVELS.join(", ")}`);
        }
        if (existing.kind !== "ticket_created") throw new Refusal(400, "level applies to tickets only");
        if (caller.kind !== "human") {
            throw new Refusal(403, "a ticket's level is set by a human moderator only", ERROR_CODES.MODERATOR_ONLY);
        }
    }
    const updated = editMessage(id, { title, body, summary, intent, priority, scope, level: level as TicketLevel | undefined });
    if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    // #509 — priority_changed lifecycle quand la priorité d'un ticket bouge
    // réellement (normalise NULL→"normal" sur les 2 côtés pour éviter un faux
    // positif). Runtime ticket_priority_changed dispatch en dépend.
    if (
        priority !== undefined
        && existing.kind === "ticket_created"
        && (existing.priority ?? "normal") !== (decorated.priority ?? "normal")
    ) {
        emitLifecycle({
            op: "priority_changed",
            message: decorated,
            old_priority: existing.priority ?? "normal",
        });
    }
    // #2241 — moving a ticket to a level its holder does not work on takes it out
    // of their backlog without a sound. Not blocked (nobody loses the ticket
    // itself), but said.
    const held = existing as { claimant?: string | null; assignee?: string | null; level?: string };
    const leftBehind = level !== undefined && level !== held.level
        ? [...new Set([held.claimant, held.assignee].filter((h): h is string => !!h && !seesLevel(h, level)))]
        : [];
    const warning = leftBehind.length > 0
        ? `held by ${leftBehind.join(", ")}, who ${leftBehind.length > 1 ? "do" : "does"} not work on ${level} tickets: this ticket now leaves their backlog and notifications`
        : null;
    return warning ? { ...decorated, warning } : decorated;
    },
});

/**
 * Accept or reject the decision a comment carries (#B.129): a plan, a
 * resolution, a wontfix, an escalation. Idempotent on the same status; a
 * decided one refuses another (409): post a fresh decision instead. #3036 —
 * who decides is the caller. `body` is a closing note for an accept that
 * closes the ticket (#980); `new_kind` requalifies it as it is decided.
 */
defineMethod({
    name: "message.decide",
    who: ["human", "agent"],
    params: z.looseObject({ id }),
    run: (caller, p) => {
    const id = p.id;
    if (!Number.isFinite(id)) throw new Refusal(400, "invalid message id");
    const body = p as {
        status?: unknown;
        decided_by?: unknown;
        new_kind?: unknown;
        // #980 `7cnyjb` — optional closing note carried on the auto-close
        // event when accepting a resolution / wontfix (front sends it here
        // instead of a separate postBodyAs("ticket_closed")).
        body?: unknown;
    };
    if (body.status !== "accepted" && body.status !== "rejected") {
        throw new Refusal(400, "status must be 'accepted' or 'rejected'");
    }
    // #3036 — who decides is who is authenticated.
    const by = authorOf(caller, body.decided_by, "decided_by");
    let newKind: DecisionKind | undefined;
    if (body.new_kind !== undefined && body.new_kind !== null) {
        if (typeof body.new_kind !== "string") {
            throw new Refusal(400, "new_kind must be a string when set");
        }
        if (!isDecisionKind(body.new_kind)) {
            throw new Refusal(400, "new_kind must be a valid decision kind");
        }
        newKind = body.new_kind;
    }
    refuseWhileTicketAwaitsModeration(id);
    // #2376 david `dvqfvt` (case 4) — only the LATEST decision of a thread can
    // be accepted or rejected. A replaced one is moot: deciding it sent the
    // agent a `plan_accepted` for a plan nobody works on any more, while the
    // newer decision kept the ticket gated. Same rule the list badges, the
    // stats and the close already follow.
    {
        const target = getMessage(id);
        const ticketId = target?.kind === "ticket_created" ? target.id : target?.ticket_id ?? null;
        if (target && ticketId != null) {
            const agg = getInboxAgg(target.project).get(ticketId);
            const latest = agg?.latestDecisionId ?? 0;
            if (latest > 0 && latest !== id) {
                const newer = getMessage(latest);
                const ref = newer?.hashid ? `#${newer.hashid}` : `message ${latest}`;
                throw new Refusal(409, `a newer decision replaced this one — decide ${ref} instead`, ERROR_CODES.DECISION_SUPERSEDED);
            }
        }
    }
    // #2910 — accepting a resolution or a wontfix closes the ticket: on a
    // milestone that still holds open tickets, refuse the accept itself rather
    // than accept and then fail the close.
    if (body.status === "accepted") {
        const target = getMessage(id);
        const ticketId = target?.kind === "ticket_created" ? target.id : target?.ticket_id ?? null;
        const ticket = ticketId != null ? getMessage(ticketId) : null;
        if (target && ticket?.level === "milestone") {
            let k: string | undefined = newKind;
            if (!k) {
                try { k = (JSON.parse(target.meta ?? "null") as { decision?: { kind?: string } } | null)?.decision?.kind; } catch { /* no decision */ }
            }
            const effect = decisionGesture(k)?.onAccept;
            if (effect === "close_resolved" || effect === "close_unresolved") {
                const open = openTicketsIn(ticket.id);
                if (open.length > 0) throw new Refusal(409, milestoneOpenRefusal(ticket.id, open), ERROR_CODES.MILESTONE_HAS_OPEN);
            }
        }
    }
    try {
        const updated = applyMessageDecision(id, body.status, by, newKind);
        if (!updated) throw new Refusal(404, "message not found", ERROR_CODES.MESSAGE_NOT_FOUND);
        // #260/#261: notify the proposal's author that their plan/resolution
        // was accepted (go-signal to execute) or rejected (ball back in
        // their court). Same service the moderation decide() path uses.
        notifyDecision(updated, by);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        // #321 phase 2 (additive): a plan/resolution decision changed (accept/
        // reject/reclassify) → emit so #322's rules can react (e.g. re-attribute
        // when a plan is accepted). The `meta.decision` carries the new state.
        emitLifecycle({ op: "decided", message: decorated });
        // #830 david `a7pn65` — emit a dedicated decision-event message so
        // the wake-injection pipeline can route it through its own template
        // branch (= the agent receives "Your plan on #X was accepted by Y"
        // verbatim instead of re-pulling the original proposal body with no
        // verbal hint). The new event is a sibling of the original comment
        // (parent_id = original.id) carrying its hashid in meta.decision_ref.
        // Best-effort : a failure here surfaces as a server log but doesn't
        // fail the decide — the meta flip already landed, the rest is just
        // narration.
        // #863 — for a TICKET-level decision (`ticket_new({then:"plan"})`,
        // #803 path), `applyMessageDecision` returns a synthesized
        // `ticket_created` Message whose `ticket_id` is null BY CONVENTION
        // (the message IS the ticket). The original guard `updated.ticket_id
        // != null` skipped the plan_accepted emission for those cases →
        // regression : ticket-level plan accept didn't wake. Fallback :
        // when the synthesized message is `ticket_created`, the ticket id
        // IS `updated.id`.
        const eventTicketId = updated.kind === "ticket_created" ? updated.id : updated.ticket_id;
        if (updated.meta && eventTicketId != null) {
            try {
                const m = JSON.parse(updated.meta) as { decision?: { kind?: string } };
                const decisionKind = m.decision?.kind;
                const eventKindStr = decisionKind && (body.status === "accepted" || body.status === "rejected")
                    ? `${decisionKind}_${body.status}`
                    : "";
                if (eventKindStr && isDecisionEventKind(eventKindStr)) {
                    // parent_id = the original proposal's message id ;
                    // the wake builder + UI resolve the backlink (e.g.
                    // hashid display) via getMessage(parent_id) — no
                    // need to duplicate the ref in meta here.
                    // Cast safe : isDecisionEventKind narrowing isn't a
                    // type guard on the string union ; the runtime check
                    // makes the cast sound.
                    submitMessage({
                        project: updated.project,
                        kind: eventKindStr as MessageKind,
                        ticket_id: eventTicketId,
                        parent_id: updated.id,
                        body: null,
                        by_agent: by,
                    });
                }
            } catch {
                /* malformed meta or decision-event insert failed — don't
                   fail the decide ; the proposal status flip is the
                   authoritative signal, the event is decoration. */
            }
        }
        // #802 + #980 `7cnyjb` — accepting a `resolution` OR a `wontfix`
        // (effective kind, post-reclassify) auto-closes the ticket from the
        // SAME endpoint. wontfix (#802) closes WITHOUT flipping resolved
        // (junk/test/out-of-scope triage) ; resolution lands as closed-resolved
        // (`resolved` is derived from the accepted meta, db/tickets.ts:103 —
        // no separate event). Pre-#980 only wontfix auto-closed here ; a
        // resolution relied on the front POSTing a separate `ticket_closed`,
        // whose fan-out was the 2nd ping (`resolution_accepted` +
        // `ticket_closed`, cf. #965/#972). Folding the close in with
        // `skipFanOut` → ONE ping. The author of the proposal can't always
        // close (non-reporter agent triaging) ; this acceptance IS the
        // reporter's close authorization. Best-effort : a failure here is
        // logged but doesn't fail the decide (the meta flip already landed).
        if (
            body.status === "accepted"
            && updated.meta
            && updated.ticket_id != null
        ) {
            try {
                const m = JSON.parse(updated.meta) as { decision?: { kind?: string } };
                const k = m.decision?.kind;
                // #2308 — which acceptances close the ticket is the table's `onAccept`.
                const effect = decisionGesture(k)?.onAccept;
                if (effect === "close_resolved" || effect === "close_unresolved") {
                    // Optional closing note rides on the close event ; wontfix
                    // keeps its synthesized default when no note is supplied.
                    const closeBody =
                        typeof body.body === "string" && body.body.trim()
                            ? body.body
                            : effect === "close_unresolved"
                                ? `(auto-close from accepted ${k} #${updated.hashid ?? id})`
                                : undefined;
                    // #921 — skip the blanket ping fan-out: the proposer already
                    // heard it through `<kind>_accepted`, and two wakes for one
                    // gesture is noise.
                    // #2380 david `75jv33` — but that accept now wakes the
                    // PROPOSER alone, so everyone else (the reporter first of
                    // all) would hear nothing at all of a ticket closing on
                    // them. The close fans out to them, minus the proposer:
                    // one wake each, nobody left out.
                    // #980 N2 — skipBroadcast : le `<kind>_accepted` est aussi
                    // la SEULE notif UI (toaster + `e:` counter). Le refresh
                    // qu'il déclenche fait re-dériver `ticket.closed` (la row
                    // existe). Sans ça, l'auto-close re-broadcaste → 2e toaster.
                    const closeMsg = submitMessage({
                        project: updated.project,
                        kind: "ticket_closed",
                        ticket_id: updated.ticket_id,
                        parent_id: updated.ticket_id,
                        body: closeBody,
                        by_agent: by,
                    }, { skipFanOut: true, skipBroadcast: true });
                    if (closeMsg.status === "approved") {
                        // #3163 — no broadcast, but the bus views still see the ticket close.
                        ticketMoved({ id: updated.ticket_id, project: updated.project }, "message_created", closeMsg);
                        fanOutPings(closeMsg, { except: updated.by_agent });
                        // #2640 — a ticket closed on an agent's accepted
                        // resolution or wontfix is proof of work: wait credit.
                        if (updated.by_agent && !isHuman(updated.by_agent)) {
                            earnOnClose(updated.by_agent, updated.project, updated.ticket_id, effect === "close_resolved" ? "resolved" : "wontfix");
                        }
                    }
                }
            } catch {
                /* malformed meta or close failed — don't fail the decide */
            }
        }
        return decorated;
    } catch (e) {
        // Domain-level conflict (no decision present, or already
        // terminal) — surface as 409 so the UI can show the reason.
        throw refusalFrom(409, e);
    }
    },
});
