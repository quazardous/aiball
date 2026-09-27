/**
 * Ping list + SSE event stream + mark-read (#B.148 phase A, carved out
 * of api.ts in #B.213 phase 1.E on 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   GET  /pings              — list pings for a consumer (limit/unreadOnly)
 *   GET  /pings/count        — unread count
 *   GET  /events             — Server-Sent Events stream of live pings
 *   POST /pings/mark-read    — ack pings (up-to-id or all)
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const pingsRouter = Router();

pingsRouter.get("/pings", serveMethod("ping.list"));

pingsRouter.get("/pings/count", serveMethod("ping.count"));

pingsRouter.post("/pings/mark-read", serveMethod("ping.mark_read"));
