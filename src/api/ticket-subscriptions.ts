/**
 * Per-ticket subscription CRUD — lets a consumer explicitly follow a
 * single ticket beyond the project-level subscription role. Carved out
 * of api.ts in #B.213 phase 1.E on 2026-05-19. Behavior-preserving.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteTicketSubscription,
    getMessage,
    getTicketSubscriptionState,
    listTicketSubscriptions,
    upsertTicketSubscription,
} from "../db.js";
import { badRequest, notFound } from "./_helpers.js";

export const ticketSubscriptionsRouter = Router();

ticketSubscriptionsRouter.get("/ticket-subscriptions", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.json({
        consumer_id: consumer,
        subscriptions: listTicketSubscriptions(consumer),
    });
});

ticketSubscriptionsRouter.post("/ticket-subscriptions", (req: Request, res: Response) => {
    const consumer = req.body?.consumer_id as string | undefined;
    const ticket_id = req.body?.ticket_id;
    if (!consumer) return badRequest(res, "consumer_id required");
    if (typeof ticket_id !== "number") {
        return badRequest(res, "ticket_id required (number)");
    }
    const t = getMessage(ticket_id);
    if (!t || t.kind !== "ticket_created") {
        return notFound(res, "ticket not found");
    }
    // #352: muted=true mutes (suppress pings even by role); default false = follow.
    const muted = req.body?.muted === true;
    upsertTicketSubscription(consumer, ticket_id, muted);
    res.status(201).json({ consumer_id: consumer, ticket_id, muted });
});

// #352: the current consumer's relationship to one ticket — "followed" /
// "muted" / null (role-default). Drives the ThreadHeader manage toggle.
ticketSubscriptionsRouter.get("/ticket-subscriptions/:ticket_id", (req, res) => {
    const ticket_id = Number(req.params.ticket_id);
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.json({
        consumer_id: consumer,
        ticket_id,
        state: getTicketSubscriptionState(consumer, ticket_id),
    });
});

ticketSubscriptionsRouter.delete("/ticket-subscriptions/:ticket_id", (req, res) => {
    const ticket_id = Number(req.params.ticket_id);
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    deleteTicketSubscription(consumer, ticket_id);
    res.json({ consumer_id: consumer, ticket_id, removed: true });
});
