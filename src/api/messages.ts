/**
 * Message CRUD + moderation + decision-on-comment routes (carved out
 * of api.ts in #B.213 phase 1.F on 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   POST /messages                              — create (ticket / comment / lifecycle)
 *   GET  /messages                              — list with filters
 *   GET  /messages/:id                          — fetch one
 *   POST /messages/:id/approve                  — moderation (human-only by convention)
 *   POST /messages/:id/reject                   — moderation
 *   POST /messages/:id/edit                     — title/body/summary/intent/priority
 *   POST /messages/:id/questions/:qid/answer    — #B.104 question audit
 *   POST /messages/:id/decide                   — #B.129 decision-on-comment accept/reject
 *   POST /messages/:id/summarize                — #B.130 set/clear comment summary_until
 *   POST /messages/:id/reclassify               — #B.129 follow-up: swap decision kind
 *   POST /messages/:id/note                     — moderator note
 *
 * `decide()` helper is local — shared by approve/reject; not exported.
 */
import { Router, type Request, type Response } from "express";
import {
    INTENTS,
    PRIORITIES,
    applyMessageDecision,
    deletePingsForMessage,
    editMessage,
    getMessage,
    insertPing,
    listMessages,
    markQuestionAnswered,
    noteMessage,
    reclassifyMessageDecision,
    setMessageSummary,
    updateMessageStatus,
    type Intent,
    type MessageKind,
    type MessageStatus,
    type Priority,
} from "../db.js";
import { isDecisionKind, type DecisionKind } from "../decisions.js";
import { fanOutPings, submitMessage, validateNewMessage } from "../messages.js";
import { deliverToOutbox } from "../outbox.js";
import { broadcast } from "../ws.js";
import { badRequest, consumerOf, notFound, withTags, withTagsOne } from "./_helpers.js";

export const messagesRouter = Router();

messagesRouter.post("/messages", (req: Request, res: Response) => {
    const v = validateNewMessage(req.body);
    if ("error" in v) return badRequest(res, v.error);
    try {
        const msg = submitMessage(v);
        return res.status(201).json(withTagsOne(msg));
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FORBIDDEN_CLOSE") {
            return res.status(403).json({ error: (err as Error).message });
        }
        throw err;
    }
});

messagesRouter.get("/messages", (req: Request, res: Response) => {
    const { status, project, kind, by_agent, limit } = req.query;
    const list = listMessages({
        status: status as MessageStatus | undefined,
        project: project as string | undefined,
        kind: kind as MessageKind | undefined,
        by_agent: typeof by_agent === "string" ? by_agent : undefined,
        limit: limit ? Number(limit) : undefined,
    });
    res.json(withTags(list));
});

messagesRouter.get("/messages/:id", (req, res) => {
    const m = getMessage(Number(req.params.id));
    if (!m) return notFound(res);
    res.json(withTagsOne(m));
});

function decide(
    req: Request,
    res: Response,
    status: MessageStatus,
): void | Response {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    if (existing.status !== "pending") {
        return badRequest(res, `message already ${existing.status}`);
    }
    const updated = updateMessageStatus(id, status, "human", null);
    if (!updated) return notFound(res);
    if (status === "approved") {
        deliverToOutbox(updated);
        // #B.245 tristate: fanOutPings itself bails out at `scope ===
        // "internal"`, so the call is unconditional again.
        fanOutPings(updated);
    } else if (status === "rejected") {
        // At-insertion fan-out had already delivered pings to subscribers.
        // The message will never be approved, so wipe those pings so it
        // stops surfacing as unread on their inboxes.
        deletePingsForMessage(id);
    }
    // Transition ping: notify the message author that a moderator (human)
    // decided their submission. Skip if the author IS the moderator (close
    // the loop on bypass-humain posts that somehow ended up in the queue).
    if (
        updated.by_agent &&
        updated.by_agent !== "human" &&
        (status === "approved" || status === "rejected")
    ) {
        insertPing(updated.by_agent, updated);
    }
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_decided", data: decorated });
    res.json(decorated);
}

messagesRouter.post("/messages/:id/approve", (req, res) => decide(req, res, "approved"));
messagesRouter.post("/messages/:id/reject", (req, res) => decide(req, res, "rejected"));

messagesRouter.post("/messages/:id/edit", (req, res) => {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    const { title, body, summary, intent, priority } = req.body ?? {};
    if (
        title === undefined &&
        body === undefined &&
        summary === undefined &&
        intent === undefined &&
        priority === undefined
    ) {
        return badRequest(res, "provide title, body, summary, intent, and/or priority");
    }
    if (intent !== undefined && intent !== null) {
        if (typeof intent !== "string" || !INTENTS.includes(intent as Intent)) {
            return badRequest(res, `intent must be one of ${INTENTS.join(", ")}`);
        }
    }
    if (priority !== undefined && priority !== null) {
        if (typeof priority !== "string" || !PRIORITIES.includes(priority as Priority)) {
            return badRequest(res, `priority must be one of ${PRIORITIES.join(", ")}`);
        }
    }
    const updated = editMessage(id, { title, body, summary, intent, priority });
    if (!updated) return notFound(res);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    res.json(decorated);
});

/**
 * Mark a question on a message as answered (#B.104). Flips
 * `- [ ]<!-- q:<qid> -->` → `- [x]<!-- q:<qid> -->` in the parent's
 * body and records the audit in `meta.questions[<qid>]`.
 *
 *   POST /api/messages/:id/questions/:qid/answer
 *   body: { answered_by: string, answered_in: number }
 *
 * Idempotent — re-answering is a no-op. Broadcasts `message_edited`
 * on success so live clients see the toggle and the chip update.
 */
messagesRouter.post("/messages/:id/questions/:qid/answer", (req, res) => {
    const id = Number(req.params.id);
    const qid = String(req.params.qid);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    if (!/^[a-zA-Z0-9_-]+$/.test(qid)) return badRequest(res, "invalid question id");
    const { answered_by, answered_in } = (req.body ?? {}) as {
        answered_by?: unknown;
        answered_in?: unknown;
    };
    if (typeof answered_by !== "string" || !answered_by) {
        return badRequest(res, "answered_by required");
    }
    if (typeof answered_in !== "number" || !Number.isFinite(answered_in)) {
        return badRequest(res, "answered_in (number) required");
    }
    const updated = markQuestionAnswered(id, qid, {
        answered_by,
        answered_at: new Date().toISOString(),
        answered_in,
    });
    if (!updated) return notFound(res);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    res.json(decorated);
});

/**
 * Decision-on-comment accept/reject (#B.129).
 *
 *   POST /api/messages/:id/decide
 *   body: { status: "accepted" | "rejected", decided_by?: string }
 *
 * The message must already carry a `meta.decision` block (the author
 * tagged it at post time via the composer dropdown). Idempotent —
 * re-applying the same status returns the row unchanged. Re-deciding
 * a terminal decision returns 409: the proper flow is to post a new
 * comment with a fresh decision (e.g. plan v2 after a rejected v1).
 */
messagesRouter.post("/messages/:id/decide", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as {
        status?: unknown;
        decided_by?: unknown;
        new_kind?: unknown;
    };
    if (body.status !== "accepted" && body.status !== "rejected") {
        return badRequest(res, "status must be 'accepted' or 'rejected'");
    }
    const by = typeof body.decided_by === "string" && body.decided_by
        ? body.decided_by
        : consumerOf(req);
    let newKind: DecisionKind | undefined;
    if (body.new_kind !== undefined && body.new_kind !== null) {
        if (typeof body.new_kind !== "string") {
            return badRequest(res, "new_kind must be a string when set");
        }
        if (!isDecisionKind(body.new_kind)) {
            return badRequest(res, "new_kind must be a valid decision kind");
        }
        newKind = body.new_kind;
    }
    try {
        const updated = applyMessageDecision(id, body.status, by, newKind);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        // Domain-level conflict (no decision present, or already
        // terminal) — surface as 409 so the UI can show the reason.
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * Set or clear a comment's one-line summary (#B.130 phase 1).
 *
 *   POST /api/messages/:id/summarize
 *   body: { summary: string }   (empty string clears)
 *
 * comment_added only. Caller permissioning is light — any participant
 * can summarize an existing comment (the audit is in updated_at, not
 * meta). Broadcasts `message_edited`.
 */
messagesRouter.post("/messages/:id/summarize", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { summary?: unknown };
    if (typeof body.summary !== "string") {
        return badRequest(res, "summary (string) required");
    }
    try {
        const updated = setMessageSummary(id, body.summary);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * Reclassify a comment's decision kind without flipping its status
 * (#B.129 follow-up — david: "je dois pouvoir requalifier en voici
 * mon plan"). Keeps the decision pending; just swaps `meta.decision
 * .kind` between `plan` and `resolution`.
 *
 *   POST /api/messages/:id/reclassify
 *   body: { new_kind: "plan" | "resolution" }
 *
 * HTTP 409 when the decision doesn't exist OR is already terminal.
 */
messagesRouter.post("/messages/:id/reclassify", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { new_kind?: unknown };
    if (typeof body.new_kind !== "string" || !isDecisionKind(body.new_kind)) {
        return badRequest(res, "new_kind must be a valid decision kind");
    }
    try {
        const updated = reclassifyMessageDecision(id, body.new_kind);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
});

messagesRouter.post("/messages/:id/note", (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body ?? {};
    const updated = noteMessage(id, typeof note === "string" ? note : null);
    if (!updated) return notFound(res);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_noted", data: decorated });
    res.json(decorated);
});
