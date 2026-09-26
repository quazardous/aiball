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
 * #3063 — a route that says `serveMethod(name)` serves the bus method of that
 * name (src/bus/methods/); the code is there, the route only maps the request.
 */
import { serveMethod } from "../bus/http.js";
import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "../domain.js";
import {
    listMessages,
    listPendingDecisionsForReporter,
    listPlansToExecute,
    type MessageKind,
    type MessageStatus,
} from "../db.js";
import { consumerOf, withTags } from "./_helpers.js";
import { addMessageTag, getTagByName, insertTag } from "../db/tags.js";
import { platformTagName } from "../db/platform-tag.js";

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
export function applyPlatformTag(msg: { id: number; kind: string }, platform: string | null): void {
    if (msg.kind !== "ticket_created") return;
    const name = platformTagName(platform);
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

/**
 * #3039 — the refusals `submitMessage` throws, by code, and their HTTP status;
 * the answer carries the code. Anything else it throws is a 500.
 */
export const SUBMIT_REFUSAL_STATUS: Partial<Record<string, number>> = {
    [ERROR_CODES.FORBIDDEN_CLOSE]: 403,
    // #561 — 400 (not 500): the client can say which project does not exist.
    [ERROR_CODES.PROJECT_NOT_FOUND]: 400,
    // #569 — the agent waits for the ticket's approval, or posts a plain comment.
    [ERROR_CODES.PARENT_PENDING_MODERATION]: 409,
    // #2308 — a step (`then: continue`) from an agent not holding the ticket.
    [ERROR_CODES.STEP_NOT_HOLDER]: 409,
    // #2910 — a milestone still holding open tickets is not released.
    [ERROR_CODES.MILESTONE_HAS_OPEN]: 409,
    // #2910 — a ticket above the levels the agent works on is read-only to it.
    [ERROR_CODES.LEVEL_READ_ONLY]: 403,
    // #2215 — the parent ticket does not exist.
    [ERROR_CODES.TICKET_NOT_FOUND]: 404,
};

// The body is the message; nothing rides in the path or the query.
messagesRouter.post("/messages", serveMethod("message.post", (req) => req.body ?? {}, { status: 201 }));

messagesRouter.get("/messages", (req: Request, res: Response) => {
    const { status, project, kind, by_agent, limit, summary, open } = req.query;
    const list = listMessages({
        status: status as MessageStatus | undefined,
        project: project as string | undefined,
        kind: kind as MessageKind | undefined,
        by_agent: typeof by_agent === "string" ? by_agent : undefined,
        limit: limit ? Number(limit) : undefined,
        // #2339 — `open=1` drops closed tickets before the limit.
        open: open === "1" || open === "true",
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

messagesRouter.get("/messages/:id", serveMethod("message.get"));

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

messagesRouter.post("/messages/:id/approve", serveMethod("message.approve"));
messagesRouter.post("/messages/:id/reject", serveMethod("message.reject"));

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
messagesRouter.post("/messages/:id/accept-and-close", serveMethod("message.accept_and_close"));

messagesRouter.post("/messages/:id/edit", serveMethod("message.edit"));

/**
 * Delete a comment (#309) — UI affordance, **human moderator only**. Soft
 * deletes (status → rejected + meta.deleted) so the comment vanishes from
 * counts / gates / brief / MCP reads, but the UI thread re-surfaces it as a
 * tombstone (GET /api/tickets/:id?include_deleted=1). Pings are wiped. Only
 * `comment_added`; refuses a comment carrying a finalized decision.
 *
 *   POST /api/messages/:id/delete   (no body)
 */
messagesRouter.post("/messages/:id/delete", serveMethod("message.delete"));

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
messagesRouter.post("/messages/:id/questions/:qid/answer", serveMethod("message.answer_question"));

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
messagesRouter.post("/messages/:id/decide", serveMethod("message.decide"));

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
messagesRouter.post("/messages/:id/resurface", serveMethod("message.resurface"));

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
messagesRouter.post("/messages/:id/summarize", serveMethod("message.summarize"));

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
messagesRouter.post("/messages/:id/vote", serveMethod("message.vote"));

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
messagesRouter.post("/messages/:id/reclassify", serveMethod("message.reclassify"));

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
messagesRouter.post("/messages/:id/promote", serveMethod("message.promote"));

/**
 * Untag a comment — clear its `meta.decision` (#B.256 dzm3ef). Only
 * pending decisions can be untagged; terminal ones (accepted /
 * rejected) keep the audit row.
 */
messagesRouter.post("/messages/:id/untag", serveMethod("message.untag"));

messagesRouter.post("/messages/:id/step", serveMethod("message.step"));
messagesRouter.post("/messages/:id/unstep", serveMethod("message.unstep"));

messagesRouter.post("/messages/:id/note", serveMethod("message.note"));
