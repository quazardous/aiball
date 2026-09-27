/**
 * Consumer CRUD + state-push routes (#B.213 phase 1.B).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 * #B.79 consumer concept; #B.177 B1 state-push.
 */
import { Router, type Request, type Response } from "express";
import { ENROLLMENT_TTL_MS } from "../db/node-enrollment.js";
import {
    collectEnrollmentToken,
    createEnrollment,
    getEnrollment,
} from "../db/node-enrollments.js";
import {
    pairingWindow,
} from "../node-pairing-window.js";
import { broadcast } from "../ws.js";
import { notFound, refuse } from "./_helpers.js";
import { ERROR_CODES } from "../domain.js";

export const consumersRouter = Router();













/**
 * #3030 — an agent's loop bar as data, for hosts other than tmux. The loop pushes
 * its own on change (throttled); a human, or the agent itself, reads it.
 * Own-bar only, and agents only — the same rule as the state push above.
 */




/**
 * #2074 — PAIRING. The two routes below are the only UNAUTHENTICATED ones in
 * this file, and necessarily so: a node asking to be enrolled has no credential
 * yet — that is the thing it is asking for.
 *
 * What keeps the door narrow is that neither route can produce a credential.
 * `POST /nodes/enroll` records an intent; `GET /nodes/enroll/:id` hands over a
 * token only if a HUMAN already approved that exact request. The worst a
 * stranger achieves is a row in a list that david will not recognise.
 *
 * The rate limit is per-IP and deliberately small. It is not a defence against
 * a determined caller — nothing here is — but it stops an accident or a script
 * from filling the panel with rows and burying a real request among them.
 */
const ENROLL_WINDOW_MS = 60_000;
const ENROLL_MAX_PER_WINDOW = 5;
const enrollHits = new Map<string, number[]>();

function enrollRateLimited(ip: string): boolean {
    const now = Date.now();
    const hits = (enrollHits.get(ip) ?? []).filter((t) => now - t < ENROLL_WINDOW_MS);
    hits.push(now);
    enrollHits.set(ip, hits);
    // Bounded: one entry per active IP, pruned as it is read.
    if (enrollHits.size > 500) {
        for (const [k, v] of enrollHits) if (v.every((t) => now - t >= ENROLL_WINDOW_MS)) enrollHits.delete(k);
    }
    return hits.length > ENROLL_MAX_PER_WINDOW;
}

consumersRouter.post("/nodes/enroll", (req: Request, res: Response) => {
    // #2074 — the switch. Shut, this route writes nothing and says so plainly:
    // a node refused here looks like a broken hub unless the message names the
    // real reason, and that confusion is the whole cost of having a window.
    if (!pairingWindow().open) {
        return res.status(403).json({
            error: "the hub is not accepting pairing right now — open the window "
                + "in aiball under Nodes, then run this again",
            code: ERROR_CODES.FORBIDDEN,
        });
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (enrollRateLimited(ip)) {
        return refuse(res, 429, "too many pairing requests — wait a minute");
    }
    const { label, display_host, display_host_provider } = (req.body ?? {}) as {
        label?: unknown; display_host?: unknown; display_host_provider?: unknown;
    };
    // #2081 — the node resolves its own name (tailscale, then hostname) the way
    // a paired one does in its WS hello, because the hub sees only the peer IP
    // and a local reverse proxy makes that 127.0.0.1 every time. Stored as a
    // CLAIM, next to the label: nothing here has been proved.
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const view = createEnrollment({
        label: str(label),
        ip,
        claimed_host: str(display_host),
        claimed_host_provider: str(display_host_provider),
    });
    // The panel should light up without waiting for a poll: this is the moment
    // a human is expected to act, and the node is standing at a prompt.
    broadcast({ type: "consumer_changed", data: { enrollment: view } });
    // The code goes back so the node can PRINT it — comparing the two screens
    // is the whole point, and it cannot be compared if only one side shows it.
    //
    // #2088 — `ttl_seconds` alongside the instant: a duration crosses machines,
    // an instant on this hub's clock does not.
    res.status(201).json({
        id: view.id,
        code: view.code,
        expires_at: view.expires_at,
        ttl_seconds: Math.round(ENROLLMENT_TTL_MS / 1000),
    });
});

consumersRouter.get("/nodes/enroll/:id", (req: Request, res: Response) => {
    const view = getEnrollment(String(req.params.id));
    if (!view) return notFound(res, "pairing request not found");
    if (view.state === "approved") {
        const token = collectEnrollmentToken(view.id);
        // Collected once. A second poll gets `delivered` and nothing else.
        if (token) return res.json({ state: "approved", token });
        return res.json({ state: "delivered" });
    }
    // Everything else says only where the request stands — never why, and never
    // anything the asker didn't already tell us.
    res.json({ state: view.state });
});






