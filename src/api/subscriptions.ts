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

export const subscriptionsRouter = Router();




