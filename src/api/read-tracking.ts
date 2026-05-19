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
    markMessageSeen,
    markSeenUpToForProject,
    pendingTicketsByAuthor,
    unreadCount,
} from "../db.js";
import { badRequest, withTags } from "./_helpers.js";

export const readTrackingRouter = Router();

readTrackingRouter.get("/unread", (req: Request, res: Response) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = req.query.project as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    if (!consumer_id || !project) {
        return badRequest(res, "consumer_id and project required");
    }
    const messages = listUnread(consumer_id, project, limit);
    res.json({
        consumer_id,
        project,
        count: unreadCount(consumer_id, project),
        messages: withTags(messages),
    });
});

readTrackingRouter.get("/unread/count", (req, res) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = req.query.project as string | undefined;
    if (!consumer_id || !project) {
        return badRequest(res, "consumer_id and project required");
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
    const { consumer_id, project, message_id, up_to_id, all } = req.body ?? {};
    if (typeof consumer_id !== "string") {
        return badRequest(res, "consumer_id required");
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
