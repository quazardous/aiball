/**
 * #2255 — POST /api/signals: an external system tells a loop "something
 * deserves attention", outside every backlog.
 *
 * A signal key is required on BOTH ways in. Over HTTP the auth middleware
 * resolves it and refuses the key anywhere else. On the Unix socket the
 * middleware trusts the caller without a token, so this route checks the key
 * itself — otherwise any local process could wake the agents. The source is the
 * key's label, never a field of the body, so a caller cannot speak as another.
 */
import { Router, type Request, type Response } from "express";
import { readBearerToken, type AuthenticatedRequest } from "../auth.js";
import { getTokenAndTouch } from "../db/tokens.js";
import { isHuman } from "../db/consumers.js";
import { ackSignal, listPendingSignals, parseSignalBody, postSignal } from "../db/signals.js";
import { emitSignal } from "../event-bus.js";
import { badRequest, consumerOf } from "./_helpers.js";

export const signalsRouter = Router();

/** Per-source rate limit: at most this many signals in a sliding minute. */
export const SIGNAL_RATE_PER_MIN = 30;
const recentBySource = new Map<string, number[]>();

function underRateLimit(source: string, nowMs: number): boolean {
    const recent = (recentBySource.get(source) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= SIGNAL_RATE_PER_MIN) {
        recentBySource.set(source, recent);
        return false;
    }
    recent.push(nowMs);
    recentBySource.set(source, recent);
    return true;
}

function signalSourceOf(req: Request): { source: string } | { status: 401 | 403; error: string } {
    const ar = req as AuthenticatedRequest;
    if (ar.token_kind === "signal" && ar.signal_source) return { source: ar.signal_source };
    const onSocket = (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const bearer = onSocket ? readBearerToken(req) : null;
    if (onSocket && !bearer) return { status: 401, error: "a signal key is required (Authorization: Bearer <key>), on the socket too" };
    if (onSocket && bearer) {
        const row = getTokenAndTouch(bearer);
        if (!row) return { status: 401, error: "invalid or expired signal key" };
        if (row.kind === "signal") return { source: row.label ?? "unnamed" };
    }
    return { status: 403, error: "posting a signal needs a signal key — aiball --human auth issue --kind signal --label <source>" };
}

signalsRouter.post("/signals", (req: Request, res: Response) => {
    const who = signalSourceOf(req);
    if ("status" in who) return res.status(who.status).json({ error: who.error });
    const parsed = parseSignalBody(who.source, req.body);
    if ("error" in parsed) return badRequest(res, parsed.error);
    if (!underRateLimit(who.source, Date.now())) {
        return res.status(429).json({ error: `too many signals from '${who.source}' — at most ${SIGNAL_RATE_PER_MIN} a minute` });
    }
    const posted = postSignal(parsed);
    for (const recipient of posted.recipients) emitSignal(recipient, posted.signal);
    res.json({ ...posted.signal, recipients: posted.recipients, refreshed: posted.refreshed });
});

/** Signals waiting for the caller. A human may look at another consumer's. */
signalsRouter.get("/signals", (req: Request, res: Response) => {
    const caller = consumerOf(req);
    const asked = typeof req.query.consumer_id === "string" && req.query.consumer_id ? req.query.consumer_id : caller;
    if (asked !== caller && !isHuman(caller)) return res.status(403).json({ error: "only a human may read another consumer's signals" });
    res.json({ consumer_id: asked, signals: listPendingSignals(asked) });
});

/** The caller's loop injected the signal: stop delivering it. */
signalsRouter.post("/signals/:id/ack", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, "invalid signal id");
    const acked = ackSignal(id, consumerOf(req));
    if (!acked) return res.status(404).json({ error: "no pending delivery of this signal for you" });
    res.json({ id, acked: true });
});
