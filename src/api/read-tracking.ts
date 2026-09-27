/**
 * Per-consumer read-state routes (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * #3067 — the routes are the HTTP face of the read-state methods
 * (src/bus/methods/read-state.ts), kept while a client still calls them.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const readTrackingRouter = Router();

readTrackingRouter.get("/unread", serveMethod("unread.list"));

readTrackingRouter.get("/unread/count", serveMethod("unread.count"));

readTrackingRouter.get("/my-pending/count", serveMethod("message.pending_count"));

readTrackingRouter.get("/micro-status", serveMethod("consumer.micro_status"));

readTrackingRouter.post("/mark-read", serveMethod("unread.mark_read"));

// #1185 (david) — one-shot operator sweep: drop already-seen pings for every
// closed ticket (the backfill for the pre-close-purge backlog). Human moderator
// only (local CLI or the web UI). Idempotent.

readTrackingRouter.post("/backlog-wake", serveMethod("backlog.record_wake"));
