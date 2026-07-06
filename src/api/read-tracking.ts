/**
 * Per-consumer read-state routes (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * Endpoints: /unread, /unread/count (project-scoped inbox view +
 * counter), /my-pending/count (author-side moderation-queue counter),
 * /mark-read (single / up-to / project-wide ack). In the legacy
 * api.ts these lived under the "subscriptions" header, but they're
 * about read-state tracking, not subscription rows.
 */
import { Router, type Request, type Response } from "express";
import {
    listUnread,
    markAllSeenForProject,
    prunePings,
    purgeSeenPingsForClosedTickets,
    markMessageSeen,
    markSeenUpToForProject,
    pendingTicketsByAuthor,
    recordBacklogWake,
    unreadCount,
} from "../db.js";
import { badRequest, consumerOf, withTags } from "./_helpers.js";
import { isHuman } from "../db.js";

export const readTrackingRouter = Router();

readTrackingRouter.get("/unread", (req: Request, res: Response) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = (req.query.project as string | undefined) || null;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    if (!consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    // #800 david `unyzvx` : project is optional. Omitted = cross-project
    // consumer-scoped FIFO (the design truth — a fan-out from another
    // project must reach this consumer's queue).
    const messages = listUnread(consumer_id, project, limit, since);
    res.json({
        consumer_id,
        project,
        count: unreadCount(consumer_id, project),
        messages: withTags(messages),
    });
});

readTrackingRouter.get("/unread/count", (req, res) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = (req.query.project as string | undefined) || null;
    if (!consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    res.json({
        consumer_id,
        project,
        count: unreadCount(consumer_id, project),
    });
});

readTrackingRouter.get("/my-pending/count", (req, res) => {
    const by_agent = req.query.by_agent as string | undefined;
    if (!by_agent) return badRequest(res, "by_agent required");
    res.json({ by_agent, count: pendingTicketsByAuthor(by_agent) });
});

readTrackingRouter.post("/mark-read", (req: Request, res: Response) => {
    const { consumer_id, project, message_id, up_to_id, all, all_projects, delete: del } = req.body ?? {};
    if (typeof consumer_id !== "string") {
        return badRequest(res, "consumer_id required");
    }
    // #1185 — targeting ANOTHER consumer's backlog (operator drain), or a
    // hard-delete, is a privileged operator action → local (UDS) trust only.
    // Self mark-seen stays open (the agent acking its own thread reads).
    // A prune that targets ANOTHER consumer, or a hard --delete, is a
    // moderator action → allow the HUMAN moderator (local UDS CLI *or* the
    // authenticated web UI, both resolve via isHuman), never an agent token.
    const localTrust =
        (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const human = localTrust || isHuman(consumerOf(req));
    const crossConsumer = consumer_id !== consumerOf(req);
    if ((crossConsumer || del === true) && !human) {
        return res.status(403).json({
            error: "targeting another consumer or delete requires a human moderator (local CLI or the web UI)",
        });
    }
    // #1185 — bulk prune across ALL projects (mark-seen or delete).
    if (all_projects === true) {
        const r = prunePings(consumer_id, { del: del === true });
        return res.json({ consumer_id, all_projects: true, deleted: del === true, ...r });
    }
    // #1185 — project-scoped delete (the mark-seen `all:true` path stays below).
    if (del === true && typeof project === "string") {
        const r = prunePings(consumer_id, { project, del: true });
        return res.json({ consumer_id, project, deleted: true, ...r });
    }
    if (typeof message_id === "number") {
        const r = markMessageSeen(consumer_id, message_id);
        return res.json({ consumer_id, message_id, ...r });
    }
    if (typeof up_to_id === "number") {
        if (typeof project !== "string") {
            return badRequest(res, "project required when up_to_id is set");
        }
        const r = markSeenUpToForProject(consumer_id, project, up_to_id);
        return res.json({ consumer_id, project, up_to_id, ...r });
    }
    if (all === true) {
        if (typeof project !== "string") {
            return badRequest(res, "project required when all:true");
        }
        const r = markAllSeenForProject(consumer_id, project);
        return res.json({ consumer_id, project, ...r });
    }
    return badRequest(
        res,
        "provide message_id (single ack), up_to_id with project (bulk ack up to id), or all:true with project (ack everything delivered)",
    );
});

// #1185 (david) — one-shot operator sweep: drop already-seen pings for every
// closed ticket (the backfill for the pre-close-purge backlog). Human moderator
// only (local CLI or the web UI). Idempotent.
readTrackingRouter.post("/pings/purge-seen-closed", (req: Request, res: Response) => {
    const localTrust =
        (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    if (!localTrust && !isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "human moderator only (local CLI or the web UI)" });
    }
    return res.json(purgeSeenPingsForClosedTickets());
});

/**
 * #786 — record that a backlog wake just named the given ticket for this
 * consumer. Upsert; a fresh wake on the same (consumer, ticket) resets
 * the cooldown clock. Called from the loop's inject site only when the
 * fired branch was backlog_mode (= FIFO empty, ticket pulled from open).
 */
readTrackingRouter.post("/backlog-wake", (req: Request, res: Response) => {
    const { consumer_id, ticket_id } = req.body ?? {};
    if (typeof consumer_id !== "string") {
        return badRequest(res, "consumer_id required");
    }
    if (typeof ticket_id !== "number") {
        return badRequest(res, "ticket_id required");
    }
    recordBacklogWake(consumer_id, ticket_id);
    return res.json({ consumer_id, ticket_id, recorded: true });
});
