/**
 * Per-consumer read-state routes (#B.213 phase 1.D).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 *
 * #3067 — the routes are the HTTP face of the read-state methods
 * (src/bus/methods/read-state.ts), kept while a client still calls them.
 */
import { Router, type Request, type Response } from "express";
import { serveMethod } from "../bus/http.js";
import {
    purgeSeenPingsForClosedTickets,
} from "../db.js";
import { consumerOf, refuse } from "./_helpers.js";
import { isHuman } from "../db.js";
import { ERROR_CODES } from "../domain.js";

export const readTrackingRouter = Router();

readTrackingRouter.get("/unread", serveMethod("unread.list"));

readTrackingRouter.get("/unread/count", serveMethod("unread.count"));

readTrackingRouter.get("/my-pending/count", serveMethod("message.pending_count"));

readTrackingRouter.get("/micro-status", serveMethod("consumer.micro_status"));

readTrackingRouter.post("/mark-read", serveMethod("unread.mark_read"));

// #1185 (david) — one-shot operator sweep: drop already-seen pings for every
// closed ticket (the backfill for the pre-close-purge backlog). Human moderator
// only (local CLI or the web UI). Idempotent.
readTrackingRouter.post("/pings/purge-seen-closed", (req: Request, res: Response) => {
    const localTrust =
        (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    if (!localTrust && !isHuman(consumerOf(req))) {
        return refuse(res, 403, "human moderator only (local CLI or the web UI)", ERROR_CODES.MODERATOR_ONLY);
    }
    return res.json(purgeSeenPingsForClosedTickets());
});

readTrackingRouter.post("/backlog-wake", serveMethod("backlog.record_wake"));
