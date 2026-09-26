/**
 * Per-ticket subscription CRUD — lets a consumer explicitly follow a
 * single ticket beyond the project-level subscription role. Carved out
 * of api.ts in #B.213 phase 1.E on 2026-05-19. Behavior-preserving.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const ticketSubscriptionsRouter = Router();

ticketSubscriptionsRouter.get("/ticket-subscriptions", serveMethod("ticket.subscriptions"));

ticketSubscriptionsRouter.post("/ticket-subscriptions", serveMethod("ticket.subscribe", undefined, { status: 201 }));

// #352: the current consumer's relationship to one ticket — "followed" /
// "muted" / null (role-default). Drives the ThreadHeader manage toggle.
ticketSubscriptionsRouter.get("/ticket-subscriptions/:ticket_id", serveMethod("ticket.subscription"));

ticketSubscriptionsRouter.delete("/ticket-subscriptions/:ticket_id", serveMethod("ticket.unsubscribe"));
