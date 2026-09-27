/**
 * Consumer CRUD + state-push routes (#B.213 phase 1.B).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 * #B.79 consumer concept; #B.177 B1 state-push.
 */
import { serveMethod } from "../bus/http.js";
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

consumersRouter.get("/consumers", serveMethod("consumer.list"));

// #2645 — one agent's wait credit: per project, and its latest movements.
consumersRouter.get("/consumers/:consumer_id/wait-credit", serveMethod("consumer.wait_credit"));

// #397: single consumer lookup (incl. micro_prompt) — the claude-loop timer
// fetches its own row to inject `{consumer_prompt}` into the wake prompt.
consumersRouter.get("/consumers/:consumer_id", serveMethod("consumer.get"));

// #442: remotely HARD-KILL the claude-loop running as <consumer_id>. Pushes a
// `control:kill` event onto the loop's live SSE (the loop already holds one) →
// the loop's timer self-rm's (kill tmux + state + exit). Works over the tailnet
// since it rides the daemon. Gated to a local/direct human moderator; proxy
// nodes are DENIED (anti-DoS — see loop-control.ts). `delivered` says whether a
// live loop was connected to receive it right now (false ⇒ nothing was running).
consumersRouter.post("/consumers/:consumer_id/loop-stop", serveMethod("consumer.stop_loop"));

// #451: send a RAW, unfiltered prompt into the loop's Claude session. The prompt
// is SPOOLED first (VOLATILE, in the daemon's memory — no DB/file, cleared on a
// daemon restart, per david) THEN delivered: if the loop is live, drain the
// spool onto its event subscription now (a `control:prompt` event → the loop
// injects the text like a wake); if it's offline the prompt waits in memory and
// is drained when the loop subscribes again (`agent.<id>.events`). Same privilege
// gate as loop-stop (moderator only; proxy nodes DENIED — an arbitrary prompt
// can hijack the agent). `delivered` = a live loop received it now; `spooled`
// is always true.
consumersRouter.post("/consumers/:consumer_id/prompt", serveMethod("consumer.prompt"));

// #2333 — a message to every agent loop running on this aiball. It is typed into
// each session right away (a control prompt does not go through the wake gates),
// and with `hold: true` each loop is then held indefinitely (NOT AFK ∞), so no
// auto-wake starts new work while the operator is away. Same privilege gate as
// loop-stop and prompt. One line per loop in the daemon log and in the reply.
consumersRouter.post("/loops/message-all", serveMethod("loops.message_all"));

// #2333 — on return: lift the hold on every agent loop (or the ones named).
consumersRouter.post("/loops/release-all", serveMethod("loops.release_all"));

consumersRouter.post("/consumers", serveMethod("consumer.upsert"));

consumersRouter.patch("/consumers/:consumer_id", serveMethod("consumer.update"));

consumersRouter.delete("/consumers/:consumer_id", serveMethod("consumer.delete"));
/**
 * #B.177 B1: claude-loop timer pushes its current state here on every
 * heartbeat tick (busy / idle / boot). `state_since` only advances on
 * transition; `state_updated_at` is touched every call (freshness
 * signal the UI uses for "offline" detection).
 *
 * Auth: own-state only — the resolved consumer (from header/token)
 * must match :consumer_id. Prevents one agent from spoofing another's
 * state. Humans can't push state (kind=human is silently rejected to
 * keep the UI semantic clean: state badges are for loop agents only).
 */
consumersRouter.put("/consumers/:consumer_id/state", serveMethod("consumer.push_state"));

/**
 * #3031 — a given agent's backlog, for a moderator watching it: the rows that
 * agent's own `GET /api/tickets?backlog=1` would get (tiers, cooldowns, steps,
 * claimability), computed for the agent rather than for the caller, so a human
 * no longer has to send the agent's identity. Plus its unread events and its
 * wait credit on the project, to save two calls. Read-only: nothing is marked
 * read and no wake is recorded. A human reads any agent's; an agent, its own.
 */
consumersRouter.get("/consumers/:consumer_id/backlog", serveMethod("consumer.backlog"));

/**
 * #3030 — an agent's loop bar as data, for hosts other than tmux. The loop pushes
 * its own on change (throttled); a human, or the agent itself, reads it.
 * Own-bar only, and agents only — the same rule as the state push above.
 */
// Over HTTP the body is the bar itself.
consumersRouter.put("/consumers/:consumer_id/bar", serveMethod("consumer.push_bar", (req) => ({ consumer_id: req.params.consumer_id, bar: req.body })));

consumersRouter.get("/consumers/:consumer_id/bar", serveMethod("consumer.bar"));

/**
 * #3044 — who draws an agent's bar: `tmux` (its status line) or `external`
 * (another host draws it from the bar data; tmux's line goes off). A loop
 * control, like AFK: a moderator's, never a proxy node's. Relayed to the loop,
 * whose kernel records it; the next bar pushed carries the new `host`.
 */
consumersRouter.post("/consumers/:consumer_id/bar-host", serveMethod("consumer.set_bar_host", undefined, { status: 202 }));

/**
 * #424: the Nodes panel feed — proxy-node tokens (kind='node') with label,
 * last activity, last peer IP, and the consumers each relays. Never exposes the
 * token value (a node is addressed by a non-secret `node_id`). Moderator-only,
 * like the other token-adjacent surfaces.
 */
consumersRouter.get("/nodes", serveMethod("node.list"));

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

/**
 * #2074 — the enrolment switch. Ordinary moderator-only routes, and that is the
 * point: the one structurally-public route in the API becomes conditional on an
 * authenticated decision, instead of standing open on its own.
 */
consumersRouter.get("/nodes/pairing", serveMethod("node.pairing"));

consumersRouter.post("/nodes/pairing/:verb", serveMethod("node.set_pairing"));

/** #2074 — the human side. Moderator-only, like every other node surface. */
consumersRouter.get("/nodes/enrollments", serveMethod("node.enrollments"));

consumersRouter.post("/nodes/enrollments/:id/:verdict", serveMethod("node.decide_enrollment"));

/** #424: revoke a node by its non-secret handle (deletes the underlying node
 *  token → the proxy can no longer relay). Moderator-only. */
consumersRouter.delete("/nodes/:node_id", serveMethod("node.revoke"));
