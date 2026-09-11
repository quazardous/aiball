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
import { ERROR_CODES, MESSAGE_SCOPES, TICKET_LEVELS, type TicketLevel } from "../domain.js";
import { seesLevel } from "../db/consumers.js";
import { clearSeenForMessage, insertPing } from "../db/pings.js";
import {
    INTENTS,
    PRIORITIES,
    applyMessageDecision,
    deleteComment,
    deletePingsForMessage,
    editMessage,
    getMessage,
    isHuman,
    listMessages,
    listPendingDecisionsForReporter,
    listPlansToExecute,
    markQuestionAnswered,
    noteMessage,
    promoteMessageToDecision,
    reclassifyMessageDecision,
    removeMessageDecision,
    setMessageSummary,
    setMessageVote,
    updateMessageStatus,
    type Intent,
    type MessageKind,
    type MessageStatus,
    type Priority,
} from "../db.js";
import { isDecisionKind, type DecisionKind } from "../decisions.js";
import { creationHandbackFor, isDecisionEventKind, submitMessage, withoutDecisionRefusal, validateNewMessage } from "../messages.js";
import { decisionGesture } from "../ticket-transitions.js";
import { fanOutPings, notifyDecision } from "../notifications.js";
import { deliverToOutbox } from "../outbox.js";
import { broadcast } from "../ws.js";
import { emitLifecycle } from "../event-bus.js";
import { badRequest, consumerOf, notFound, withTags, withTagsOne, withVotesOne } from "./_helpers.js";
import { addMessageTag, getTagByName, insertTag } from "../db/tags.js";
import { platformTagName } from "../db/platform-tag.js";
import { applyModeration } from "./moderation.js";

export const messagesRouter = Router();

/**
 * #2099 — stamp the filing machine's platform on a new ticket.
 *
 * Applied here rather than in the MCP tool so it cannot be forgotten by a
 * client: the CLI, the MCP and anything else that files a ticket go through
 * this route. Creation only — a comment inherits its thread's tags by being on
 * it, and tagging each one would say nothing new.
 *
 * Best-effort by construction. A ticket that exists is worth more than a
 * ticket that is perfectly labelled, so a failure here is logged and the
 * creation still succeeds.
 */
function applyPlatformTag(msg: { id: number; kind: string }, req: Request): void {
    if (msg.kind !== "ticket_created") return;
    const header = req.headers["x-aiball-platform"];
    const name = platformTagName(typeof header === "string" ? header : null);
    // No header, or a platform we have no name for: nothing happens, and a
    // client that never sends it files tickets exactly as it always has.
    if (!name) return;
    try {
        // Created on first use. Safe only because `platformTagName` is a total
        // server-side map onto three names — see its module doc.
        const tag = getTagByName(name) ?? insertTag({ name, note: "Set automatically from the filing machine's platform." });
        addMessageTag(msg.id, tag.id, "aiball");
    } catch (e) {
        console.error(`[platform-tag] could not apply ${name} to #${msg.id}:`, e);
    }
}

messagesRouter.post("/messages", (req: Request, res: Response) => {
    const v = validateNewMessage(req.body);
    if ("error" in v) return badRequest(res, v.error);
    // #830 — decision-event kinds (plan_accepted / plan_rejected / …) are
    // emitted server-side by the /decide handler ONLY. External callers
    // can't fabricate them: a real accept/reject must flow through the
    // decision validation pipeline (gates by-status, applies the meta
    // flip atomically). Reject any direct POST with one of these kinds.
    if (isDecisionEventKind(v.kind)) {
        return badRequest(res, `kind ${v.kind} is server-emitted only — use POST /messages/:id/decide to accept/reject a decision`);
    }
    // #595 — auto-fill by_agent from the auth context when the caller omits
    // it. The bulk-close UI in App.vue calls POST /messages without by_agent
    // and `submitMessage` then can't run `assertCloseAuthority` properly
    // (no consumer to compare to the ticket reporter, no isHuman bypass) —
    // every close on a ticket the moderator didn't open returned 403. Same
    // pattern as api/tickets.ts:assign which has always done `consumerOf(req)`.
    if (!v.by_agent) v.by_agent = consumerOf(req);
    // #2275 / #2331 — an agent's comment carries a then, or says whether it hands the ticket back.
    const noDecision = withoutDecisionRefusal(v, consumerOf(req));
    if (noDecision) return badRequest(res, noDecision);
    // #2331 — a project's lead filing a ticket without a plan is reminded, not refused.
    const warning = v.kind === "ticket_created" ? creationHandbackFor(v).warning : null;
    try {
        const msg = submitMessage(v);
        applyPlatformTag(msg, req);
        return res.status(201).json({ ...withTagsOne(msg), ...(warning ? { warnings: [warning] } : {}) });
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === ERROR_CODES.FORBIDDEN_CLOSE) {
            return res.status(403).json({ error: (err as Error).message });
        }
        // #561 — 400 (not 500) so the UI/MCP client can surface a usable
        // message when the project doesn't exist.
        if (code === ERROR_CODES.PROJECT_NOT_FOUND) {
            return res.status(400).json({ error: (err as Error).message });
        }
        // #569 — 409 conflict: agent must wait for the ticket to be approved
        // or post a plain comment instead of a resolution/plan proposal.
        if (code === ERROR_CODES.PARENT_PENDING_MODERATION) {
            return res.status(409).json({ error: (err as Error).message });
        }
        // #2308 — a step (`then: continue`) from an agent not holding the ticket.
        if (code === ERROR_CODES.STEP_NOT_HOLDER) {
            return res.status(409).json({ error: (err as Error).message });
        }
        // #2215 — the parent ticket does not exist.
        if (code === ERROR_CODES.TICKET_NOT_FOUND) {
            return res.status(404).json({ error: (err as Error).message });
        }
        throw err;
    }
});

messagesRouter.get("/messages", (req: Request, res: Response) => {
    const { status, project, kind, by_agent, limit, summary } = req.query;
    const list = listMessages({
        status: status as MessageStatus | undefined,
        project: project as string | undefined,
        kind: kind as MessageKind | undefined,
        by_agent: typeof by_agent === "string" ? by_agent : undefined,
        limit: limit ? Number(limit) : undefined,
    });
    // #2198 — `summary=1` drops the bodies HERE, before they cross the socket.
    // poll() used to fetch every pending ticket with its full body and throw
    // the bodies away in the MCP process: 92 919 bytes on the wire to deliver
    // 35 690. A projection belongs where the data is.
    const rows = summary === "1" || summary === "true"
        ? list.map((m) => {
            const r: Record<string, unknown> = { ...m };
            delete r.body;
            delete r.original_body;
            return r;
        }) as unknown as typeof list
        : list;
    res.json(withTags(rows));
});

messagesRouter.get("/messages/:id", (req, res) => {
    const m = getMessage(Number(req.params.id));
    if (!m) return notFound(res);
    res.json(withTagsOne(m));
});

/**
 * #697 F5 (pisynth-claude #692) — "ball in MY court" lens. Lists every
 * pending plan / resolution decision on OPEN tickets the caller reports,
 * so the agent can see the arbitrage queue at a glance instead of
 * walking each thread.
 */
messagesRouter.get("/decisions/mine", (req: Request, res: Response) => {
    const consumer = consumerOf(req);
    const decisions = listPendingDecisionsForReporter(consumer);
    res.json({ decisions });
});

/**
 * #1164 S1 — the other direction : plans of MINE that were ACCEPTED and I
 * haven't acted on since ("what should I go execute now"). Feeds poll().
 */
messagesRouter.get("/decisions/plans-to-execute", (req: Request, res: Response) => {
    const consumer = consumerOf(req);
    res.json({ plans: listPlansToExecute(consumer) });
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
    // #2180 — the ripple lives in ./moderation.ts so the pending-children
    // sweep applies exactly the same side-effects per child.
    const decorated = applyModeration(existing, status, consumerOf(req));
    if (!decorated) return notFound(res);
    res.json(decorated);
}

messagesRouter.post("/messages/:id/approve", (req, res) => decide(req, res, "approved"));
messagesRouter.post("/messages/:id/reject", (req, res) => decide(req, res, "rejected"));

/**
 * #618 (spinoff de #617) — atomic accept-and-close. Avant : le client
 * faisait 2 round-trips (approve + post ticket_closed) avec un
 * intermediate-state WS visible entre les 2, qui flickait la dock
 * d'actions. Le client gate de #617 a masqué le symptôme côté UI ;
 * cet endpoint élimine la cause (le round-trip dual).
 *
 * Server-side : on enchaîne synchroniquement (1) approve la décision
 * pending, (2) insert un message `ticket_closed` sur le ticket parent.
 * Les WS broadcasts existants se déclenchent toujours côté chaque étape
 * mais arrivent dos-à-dos chez le client (~1ms vs ~200ms réseau avant)
 * → la fenêtre intermédiaire est essentiellement invisible.
 *
 * Pas de vraie transaction SQL atomique pour V0 — si l'insert close
 * échoue après l'approve, on retourne 500 et le client doit catch-up
 * (le state-changed du approve reste valide). Future-work pour
 * envelopper les 2 dans une transaction Drizzle si on observe des
 * échecs partiels.
 */
messagesRouter.post("/messages/:id/accept-and-close", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    if (existing.status !== "pending") {
        return badRequest(res, `message already ${existing.status}`);
    }
    if (!existing.ticket_id) {
        return badRequest(res, "message has no parent ticket to close");
    }
    // Step 1 : approve the pending decision message. Inline mirror of
    // decide(req, res, "approved") minus the res.json — we want to ship
    // the combined response below.
    const approved = updateMessageStatus(id, "approved", "human", null, existing.kind);
    if (!approved) return notFound(res);
    const approvedDecorated = withTagsOne(approved);
    deliverToOutbox(approved);
    fanOutPings(approved);
    notifyDecision(approved, consumerOf(req));
    broadcast({ type: "message_decided", data: approvedDecorated });
    emitLifecycle({ op: "decided", message: approvedDecorated });
    // No status_changed emit : that hook fires only for ticket_created
    // status flips ; this is a comment-with-decision approval.
    // Step 2 : insert the ticket_closed event. submitMessage handles its
    // own broadcasts + close-time cleanup (autoApproveStaleDecisionsOnClose
    // etc) inside its existing path.
    const byAgent = consumerOf(req);
    const body = typeof req.body?.body === "string" ? req.body.body : undefined;
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
        return res.json({
            approved: approvedDecorated,
            closed: withTagsOne(closeMsg),
        });
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === ERROR_CODES.FORBIDDEN_CLOSE) {
            return res.status(403).json({ error: (err as Error).message });
        }
        // The approve already landed ; we surface the close error so the
        // client knows to refresh + retry the close manually.
        return res.status(500).json({
            error: `accepted resolution but failed to close: ${(err as Error).message}`,
            approved: approvedDecorated,
        });
    }
});

messagesRouter.post("/messages/:id/edit", (req, res) => {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    const { title, body, summary, intent, priority, scope, level } = req.body ?? {};
    if (
        title === undefined &&
        body === undefined &&
        summary === undefined &&
        intent === undefined &&
        priority === undefined &&
        scope === undefined &&
        level === undefined
    ) {
        return badRequest(res, "provide title, body, summary, intent, priority, scope, and/or level");
    }
    // #1565 — `title` is the ticket's real column (NOT NULL), no longer an
    // overlay that null could clear. Reject rather than 500 at the DB layer.
    if (title !== undefined && typeof title !== "string") {
        return badRequest(res, "title must be a string");
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
    // #553 — scope is the #B.245 tristate.
    if (scope !== undefined && scope !== null) {
        if (typeof scope !== "string" || !(MESSAGE_SCOPES as readonly string[]).includes(scope)) {
            return badRequest(res, `scope must be one of ${MESSAGE_SCOPES.join(", ")}`);
        }
    }
    // #2216/#2241 — a ticket's level decides whose backlog and notifications it
    // reaches, so a human sets it: an agent able to move a ticket to another level
    // could drop it out of every coder's queue.
    if (level !== undefined) {
        if (typeof level !== "string" || !(TICKET_LEVELS as readonly string[]).includes(level)) {
            return badRequest(res, `level must be one of ${TICKET_LEVELS.join(", ")}`);
        }
        if (existing.kind !== "ticket_created") return badRequest(res, "level applies to tickets only");
        if (!isHuman(consumerOf(req))) {
            return res.status(403).json({ error: "a ticket's level is set by a human moderator only" });
        }
    }
    const updated = editMessage(id, { title, body, summary, intent, priority, scope, level: level as TicketLevel | undefined });
    if (!updated) return notFound(res);
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
    res.json(warning ? { ...decorated, warning } : decorated);
});

/**
 * Delete a comment (#309) — UI affordance, **human moderator only**. Soft
 * deletes (status → rejected + meta.deleted) so the comment vanishes from
 * counts / gates / brief / MCP reads, but the UI thread re-surfaces it as a
 * tombstone (GET /api/tickets/:id?include_deleted=1). Pings are wiped. Only
 * `comment_added`; refuses a comment carrying a finalized decision.
 *
 *   POST /api/messages/:id/delete   (no body)
 */
messagesRouter.post("/messages/:id/delete", (req, res) => {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    if (existing.kind !== "comment_added") {
        return badRequest(res, "only comments can be deleted");
    }
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({
            error: "only a registered human moderator can delete a comment",
        });
    }
    let updated;
    try {
        updated = deleteComment(id, caller);
    } catch (e) {
        return badRequest(res, (e as Error).message);
    }
    if (!updated) return notFound(res);
    deletePingsForMessage(id);
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
        // #980 `7cnyjb` — optional closing note carried on the auto-close
        // event when accepting a resolution / wontfix (front sends it here
        // instead of a separate postBodyAs("ticket_closed")).
        body?: unknown;
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
                    // #921 — skip ping fan-out : `<kind>_accepted` a déjà
                    // pingé ; le ticket_closed est redondant côté ping.
                    // #980 N2 — skipBroadcast : le `<kind>_accepted` est aussi
                    // la SEULE notif UI (toaster + `e:` counter). Le refresh
                    // qu'il déclenche fait re-dériver `ticket.closed` (la row
                    // existe). Sans ça, l'auto-close re-broadcaste → 2e toaster.
                    submitMessage({
                        project: updated.project,
                        kind: "ticket_closed",
                        ticket_id: updated.ticket_id,
                        parent_id: updated.ticket_id,
                        body: closeBody,
                        by_agent: by,
                    }, { skipFanOut: true, skipBroadcast: true });
                }
            } catch {
                /* malformed meta or close failed — don't fail the decide */
            }
        }
        res.json(decorated);
    } catch (e) {
        // Domain-level conflict (no decision present, or already
        // terminal) — surface as 409 so the UI can show the reason.
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * #827 david `n4ejhf` / `bur6be` — resurface a message : reset `seen_at`
 * on every ping row pointing at it, so recipients re-see it at their
 * next wake. Use case : a comment the recipients drained-but-never-acted
 * on (the skybot bug pattern from #823) — the human can re-queue it
 * without re-posting noise. Human-only convention — agents must NOT be
 * able to fabricate "re-unread" from MCP.
 *
 *   POST /api/messages/:id/resurface
 *   → { resurfaced: N }   (count of pings that flipped from seen → unseen)
 */
messagesRouter.post("/messages/:id/resurface", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({
            error: "only a registered human moderator can resurface a message",
        });
    }
    const { resurfaced } = clearSeenForMessage(id);
    // Broadcast so subscribers (UI list rows) refresh their unread chip.
    broadcast({ type: "message_edited", data: withTagsOne(existing) });
    res.json({ resurfaced });
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
 * #518 (david `uzwfc3` MVP option A) — vote +1/-1 sur un commentaire,
 * per-author. Body `{value: 1 | -1 | 0}` ; 0 retract le vote courant.
 * Returns the message décoré avec `votes_summary` pour le voter, +
 * broadcast pour que les autres clients live recomputent leur summary
 * (chaque viewer a sa `mine` propre, donc côté UI on re-décore localement).
 *
 *   POST /api/messages/:id/vote
 *   body: { value: 1 | -1 | 0 }
 *
 * 409 si la cible n'est pas un commentaire (votes comment-only).
 */
messagesRouter.post("/messages/:id/vote", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { value?: unknown };
    if (body.value !== 1 && body.value !== -1 && body.value !== 0) {
        return badRequest(res, "value must be 1, -1, or 0");
    }
    const voter = consumerOf(req);
    try {
        const updated = setMessageVote(id, voter, body.value);
        if (!updated) return notFound(res);
        const decorated = withVotesOne(withTagsOne(updated), voter);
        // Broadcast pour live update — chaque viewer recompute son `mine` côté
        // client à partir de meta.votes (qui IS dans le payload broadcasté).
        broadcast({ type: "message_edited", data: decorated });
        // #749 david `wfhw74` — un thumb-up landé sur un commentaire pingue
        // son author (= surface dans la wake-FIFO via la voie standard). Pas
        // de ping sur -1 (thumb down) ni 0 (retract) — david a explicitement
        // dit "thumb up". `insertPing` dedup via son unique (recipient,
        // ticket, comment), donc multi-voters sur le même commentaire ne
        // spamment pas l'author (un seul ping consolidé).
        if (body.value === 1 && updated.by_agent && updated.by_agent !== voter) {
            insertPing(updated.by_agent, updated, voter);
        }
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

/**
 * Promote an existing comment to a decision (#B.256). Two flows:
 *   - `body = { kind }`           — tag as pending plan/resolution
 *   - `body = { kind, status }`   — tag + decide in one gesture
 *     where status ∈ { "accepted", "rejected" }.
 *
 * Used by the per-comment "classify" dropdown in MessageCard.vue.
 * Reporter-only by convention (the frontend gates the affordance);
 * the daemon doesn't second-guess that here.
 */
messagesRouter.post("/messages/:id/promote", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { kind?: unknown; status?: unknown };
    if (typeof body.kind !== "string" || !isDecisionKind(body.kind)) {
        return badRequest(res, "kind must be a valid decision kind");
    }
    let status: "accepted" | "rejected" | undefined;
    if (body.status !== undefined && body.status !== null) {
        if (body.status !== "accepted" && body.status !== "rejected") {
            return badRequest(res, "status must be accepted or rejected (omit for pending)");
        }
        status = body.status;
    }
    try {
        const by = consumerOf(req);
        const updated = promoteMessageToDecision(id, body.kind, status, by);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * Untag a comment — clear its `meta.decision` (#B.256 dzm3ef). Only
 * pending decisions can be untagged; terminal ones (accepted /
 * rejected) keep the audit row.
 */
messagesRouter.post("/messages/:id/untag", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    try {
        const updated = removeMessageDecision(id);
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
