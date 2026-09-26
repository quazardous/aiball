/**
 * Project subscription CRUD (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * Note: the legacy section in api.ts labeled "subscriptions" mixed in
 * read-tracking routes (/unread, /mark-read) which aren't really
 * subscriptions — those moved to ./api/read-tracking.ts. This file
 * is just the subscriptions table CRUD.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const subscriptionsRouter = Router();

subscriptionsRouter.post("/subscriptions", serveMethod("project.subscribe", undefined, { status: 201 }));

subscriptionsRouter.get("/subscriptions", serveMethod("project.subscriptions"));

subscriptionsRouter.delete("/subscriptions", serveMethod("project.unsubscribe", undefined, { status: 204, respond: (res) => { res.end(); } }));
