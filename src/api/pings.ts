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
import { Router, type Request, type Response } from "express";
import {
    listPings,
    markPingsRead,
    unreadPingCount,
} from "../db.js";
import { onPing, onControl } from "../event-bus.js";
import { drainPrompts } from "../loop-prompts.js";
import { presenceConnect, presenceDisconnect } from "../live-presence.js";
import { badRequest } from "./_helpers.js";

export const pingsRouter = Router();

pingsRouter.get("/pings", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const pings = listPings({ recipient: consumer, unreadOnly, limit });
    res.json({ consumer_id: consumer, count: pings.length, pings });
});

pingsRouter.get("/pings/count", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.json({ consumer_id: consumer, unread: unreadPingCount(consumer) });
});

/**
 * Server-Sent Events stream for live ping notifications (#B.148
 * phase A). Long-lived connection per consumer; the daemon flushes a
 * `ping` event whenever `insertPing` fires for this consumer. Clients
 * (claude-loop timer, autopoll daemon, UI badge) react instantly
 * without polling.
 *
 * Wire format:
 *   event: hello
 *   data: {"consumer_id":"…","unread":N}
 *
 *   event: ping
 *   data: {"ticket_id":N,"intent":"request"}       // ticket ping
 *   data: {"ticket_id":N,"comment_id":N,"comment_hashid":"abcdef","intent":"panic"}
 *                              // comment ping — ticket_id is the
 *                              // parent ticket; comment_hashid is the
 *                              // public ref (`#<hashid>`); comment_id
 *                              // is the numeric `_messages.id` (kept
 *                              // for backward-compat — prefer hashid);
 *                              // intent is the PARENT ticket's intent
 *                              // (panic / request / question / fyi),
 *                              // so consumers can scale UI/wake-phrase
 *                              // urgency
 *
 *   :keepalive 30s              // SSE comment, ignored by parsers
 *
 * Keepalive every 30s prevents proxies/UDS buffers from killing the
 * idle stream. Client tears down the connection on its end.
 */
pingsRouter.get("/events", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({
        consumer_id: consumer,
        unread: unreadPingCount(consumer),
    })}\n\n`);
    const off = onPing(consumer, (payload) => {
        res.write(`event: ping\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    // #442: out-of-band control events (e.g. remote hard-kill) ride the same
    // live SSE the loop already holds. The loop's timer acts on them.
    const offControl = onControl(consumer, (payload) => {
        res.write(`event: control\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    // #451: flush any prompts spooled while this loop was offline — its control
    // SSE is live now, so write them straight onto the stream (drained == sent).
    for (const text of drainPrompts(consumer)) {
        res.write(`event: control\ndata: ${JSON.stringify({ action: "prompt", text })}\n\n`);
    }
    const ka = setInterval(() => {
        res.write(`:keepalive ${new Date().toISOString()}\n\n`);
    }, 30_000);
    // #395: this live SSE connection IS the loop's liveness signal. Register it
    // → near-realtime running detection (open→running, close→running:false after
    // grace), broadcast from live-presence. `source` (#395 jvdxez) distinguishes
    // a UI-launched loop from a terminal one. Disconnect must run exactly once
    // (req fires both 'close' and 'error') — guard the decrement.
    const source = req.query.source === "ui" ? "ui" : "terminal";
    presenceConnect(consumer, source);
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(ka);
        off();
        offControl();
        presenceDisconnect(consumer);
        try { res.end(); } catch { /* already closed */ }
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
});

pingsRouter.post("/pings/mark-read", (req: Request, res: Response) => {
    const consumer = req.body?.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    const all = req.body?.all === true;
    const upToId = typeof req.body?.up_to_id === "number" ? req.body.up_to_id : undefined;
    if (!all && upToId === undefined) {
        return badRequest(res, "provide up_to_id or all=true");
    }
    const r = markPingsRead({ recipient: consumer, all, upToId });
    res.json({ consumer_id: consumer, ...r });
});
