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
import { keyFor } from "./keys.js";
import { slidingLimiter } from "../rate-limit.js";
import { parseSignalBody, postSignal } from "../db/signals.js";
import { emitSignal } from "../event-bus.js";
import { badRequest, refuse } from "./_helpers.js";

export const signalsRouter = Router();

/** Per-source rate limit: at most this many signals in a sliding minute. */
export const SIGNAL_RATE_PER_MIN = 30;
const perSource = slidingLimiter({ windowMs: 60_000, max: SIGNAL_RATE_PER_MIN });

signalsRouter.post("/signals", (req: Request, res: Response) => {
    const who = keyFor(req, "signals", "posting a signal needs a signal key — aiball --human auth issue --kind signal --label <source>");
    if ("status" in who) return refuse(res, who.status, who.error, who.code);
    const parsed = parseSignalBody(who.source, req.body);
    if ("error" in parsed) return badRequest(res, parsed.error);
    if (!perSource.hit(who.source)) {
        return refuse(res, 429, `too many signals from '${who.source}' — at most ${SIGNAL_RATE_PER_MIN} a minute`);
    }
    const posted = postSignal(parsed);
    for (const recipient of posted.recipients) emitSignal(recipient, posted.signal);
    res.json({ ...posted.signal, recipients: posted.recipients, refreshed: posted.refreshed });
});



