/**
 * Consumer CRUD + state-push routes (#B.213 phase 1.B).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 * #B.79 consumer concept; #B.177 B1 state-push.
 */
import { Router, type Request, type Response } from "express";
import { AGENT_TYPES, type AgentType } from "../db/consumers.js";
import {
    deleteConsumer,
    ensureConsumer,
    getConsumer,
    listConsumers,
    pingCountsByConsumer,
    setConsumerState,
    updateConsumer,
    upsertConsumer,
    isHuman,
    type Consumer,
    type ConsumerKind,
} from "../db.js";
import { listNodesWithRevoked, revokeNode } from "../db/nodes.js";
import { ENROLLMENT_TTL_MS } from "../db/node-enrollment.js";
import {
    approveEnrollment,
    collectEnrollmentToken,
    createEnrollment,
    getEnrollment,
    listEnrollments,
    rejectEnrollment,
} from "../db/node-enrollments.js";
import { getProxyNodeWsState } from "../proxy-ws.js";
import {
    DEFAULT_PAIRING_WINDOW_MS,
    closePairingWindow,
    openPairingWindow,
    pairingWindow,
} from "../node-pairing-window.js";
import { broadcast } from "../ws.js";
import { emitControl } from "../event-bus.js";
import { isPresent, presenceRunning } from "../live-presence.js";
import { canControlLoop } from "../loop-control.js";
import { spoolPrompt, drainPrompts } from "../loop-prompts.js";
import { badRequest, consumerOf, notFound, tokenKindOf } from "./_helpers.js";

export const consumersRouter = Router();

consumersRouter.get("/consumers", (_req, res) => {
    // #443: surface the live-presence verdict (#395) per consumer so the UI can
    // render online/offline AUTHORITATIVELY — a killed loop reads offline within
    // the SSE grace (~6s) instead of lingering the full 120s heartbeat window
    // (the bug david saw: "running" traîne après kill). Tri-state, mirroring
    // `consumerEffectiveRunning` server-side: true = live (or in grace), false =
    // seen-then-gone this session (authoritative STOP), null = never seen via SSE
    // this session → client falls back to the `state_updated_at` freshness bridge.
    // #1185 — per-consumer raw ping tally (total + unseen) for the list.
    const pings = pingCountsByConsumer();
    res.json(listConsumers().map((c) => ({
        ...c,
        present: presenceRunning(c.consumer_id),
        ping_count: pings.get(c.consumer_id)?.total ?? 0,
        ping_unseen: pings.get(c.consumer_id)?.unseen ?? 0,
    })));
});

// #397: single consumer lookup (incl. micro_prompt) — the claude-loop timer
// fetches its own row to inject `{consumer_prompt}` into the wake prompt.
consumersRouter.get("/consumers/:consumer_id", (req: Request, res: Response) => {
    const c = getConsumer(String(req.params.consumer_id));
    if (!c) return notFound(res, "consumer not found");
    res.json(c);
});

// #442: remotely HARD-KILL the claude-loop running as <consumer_id>. Pushes a
// `control:kill` event onto the loop's live SSE (the loop already holds one) →
// the loop's timer self-rm's (kill tmux + state + exit). Works over the tailnet
// since it rides the daemon. Gated to a local/direct human moderator; proxy
// nodes are DENIED (anti-DoS — see loop-control.ts). `delivered` says whether a
// live loop was connected to receive it right now (false ⇒ nothing was running).
consumersRouter.post("/consumers/:consumer_id/loop-stop", (req: Request, res: Response) => {
    const target = String(req.params.consumer_id);
    const verdict = canControlLoop(tokenKindOf(req), isHuman(consumerOf(req)));
    if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    const delivered = isPresent(target);
    emitControl(target, { action: "kill" });
    res.json({ consumer_id: target, action: "kill", delivered });
});

// #451: send a RAW, unfiltered prompt into the loop's Claude session. The prompt
// is SPOOLED first (VOLATILE, in the daemon's memory — no DB/file, cleared on a
// daemon restart, per david) THEN delivered: if the loop is live, drain the
// spool onto its SSE now (a `control:prompt` event → the loop injects the text
// like a wake, PTY proxy / tmux); if it's offline the prompt waits in memory and
// is drained when the loop's SSE reconnects (see /api/events). Same privilege
// gate as loop-stop (moderator only; proxy nodes DENIED — an arbitrary prompt
// can hijack the agent). `delivered` = a live loop received it now; `spooled`
// is always true.
consumersRouter.post("/consumers/:consumer_id/prompt", (req: Request, res: Response) => {
    const target = String(req.params.consumer_id);
    const verdict = canControlLoop(tokenKindOf(req), isHuman(consumerOf(req)));
    if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return badRequest(res, "text required");
    spoolPrompt(target, text);
    const present = isPresent(target);
    if (present) {
        // Live → flush the whole queue (this prompt + anything spooled earlier).
        for (const t of drainPrompts(target)) emitControl(target, { action: "prompt", text: t });
    }
    res.json({ consumer_id: target, action: "prompt", spooled: true, delivered: present });
});

consumersRouter.post("/consumers", (req: Request, res: Response) => {
    const { consumer_id, kind, display_name, enabled, note } = (req.body ?? {}) as {
        consumer_id?: unknown;
        kind?: unknown;
        display_name?: unknown;
        enabled?: unknown;
        note?: unknown;
    };
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (kind !== undefined && kind !== "human" && kind !== "agent" && kind !== "sandbox") {
        return badRequest(res, "kind must be 'human', 'agent', or 'sandbox'");
    }
    const c = upsertConsumer({
        consumer_id,
        kind: kind as ConsumerKind | undefined,
        display_name: typeof display_name === "string" ? display_name : null,
        enabled: typeof enabled === "boolean" ? enabled : true,
        note: typeof note === "string" ? note : null,
    });
    broadcast({ type: "consumer_changed", data: c });
    res.json(c);
});

consumersRouter.patch("/consumers/:consumer_id", (req: Request, res: Response) => {
    const consumer_id = String(req.params.consumer_id);
    const body = (req.body ?? {}) as {
        kind?: unknown;
        display_name?: unknown;
        enabled?: unknown;
        note?: unknown;
        micro_prompt?: unknown;
        can_claim?: unknown;
        can_create_agent?: unknown;
        agent_type?: unknown;
        notify_project_broadcasts?: unknown;
    };
    if (body.kind !== undefined && body.kind !== "human" && body.kind !== "agent" && body.kind !== "sandbox") {
        return badRequest(res, "kind must be 'human', 'agent', or 'sandbox'");
    }
    // #1477 — a consumer's CAPABILITY fields are human-piloted and never
    // writable by an agent. Without this guard any authenticated agent could
    // flip its own `can_claim` (self-promote out of assignment-only), which
    // would make the whole #1435 authority model — and #508's specialist
    // no-claim consumers already in prod — decorative. Mirrors the human gate
    // on the sibling routes (loop-stop / prompt / nodes). Non-capability
    // fields (display_name, note, micro_prompt, …) stay editable as before.
    // Future capability flags (e.g. can_create_agent) join CAPABILITY_FIELDS.
    // #2201 — agent_type joins them: which MCP tools an agent is shown is decided
    // by a human, never by the agent itself.
    const CAPABILITY_FIELDS = ["can_claim", "can_create_agent", "agent_type"] as const;
    const touchesCapability = CAPABILITY_FIELDS.some((f) => body[f] !== undefined);
    if (touchesCapability && !isHuman(consumerOf(req))) {
        return res.status(403).json({
            error: "consumer capability fields (can_claim, can_create_agent, agent_type) are human-only — set them via the moderator UI, not from an agent",
        });
    }
    if (body.agent_type !== undefined && !(AGENT_TYPES as readonly unknown[]).includes(body.agent_type)) {
        return badRequest(res, `agent_type must be one of: ${AGENT_TYPES.join(", ")}`);
    }
    const patch: {
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
        micro_prompt?: string | null;
        can_claim?: boolean;
        can_create_agent?: boolean;
        agent_type?: AgentType;
        notify_project_broadcasts?: boolean | null;
    } = {};
    if (body.kind !== undefined) patch.kind = body.kind as ConsumerKind;
    if (body.display_name !== undefined) {
        patch.display_name = body.display_name === null
            ? null
            : (typeof body.display_name === "string" ? body.display_name : null);
    }
    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
        patch.enabled = body.enabled;
    }
    if (body.note !== undefined) {
        patch.note = body.note === null ? null : (typeof body.note === "string" ? body.note : null);
    }
    if (body.micro_prompt !== undefined) {
        patch.micro_prompt = body.micro_prompt === null
            ? null
            : (typeof body.micro_prompt === "string" ? body.micro_prompt : null);
    }
    if (body.can_claim !== undefined && typeof body.can_claim === "boolean") {
        patch.can_claim = body.can_claim;
    }
    if (body.can_create_agent !== undefined && typeof body.can_create_agent === "boolean") {
        patch.can_create_agent = body.can_create_agent;
    }
    if (body.agent_type !== undefined) patch.agent_type = body.agent_type as AgentType;
    // #516 — tri-state (null | true | false). API accepte les 3 valeurs ;
    // tout autre type est silently ignored (no-op).
    if (body.notify_project_broadcasts === null
        || body.notify_project_broadcasts === true
        || body.notify_project_broadcasts === false) {
        patch.notify_project_broadcasts = body.notify_project_broadcasts;
    }
    const updated: Consumer | null = updateConsumer(consumer_id, patch);
    if (!updated) return notFound(res, "consumer not found");
    broadcast({ type: "consumer_changed", data: updated });
    res.json(updated);
});

consumersRouter.delete("/consumers/:consumer_id", (req: Request, res: Response) => {
    const consumer_id = String(req.params.consumer_id);
    const c = getConsumer(consumer_id);
    if (!c) return notFound(res, "consumer not found");
    deleteConsumer(consumer_id);
    broadcast({ type: "consumer_changed", data: { consumer_id, deleted: true } });
    res.json({ consumer_id, deleted: true });
});

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
consumersRouter.put("/consumers/:consumer_id/state", (req: Request, res: Response) => {
    const target = String(req.params.consumer_id);
    const caller = consumerOf(req);
    if (target !== caller) {
        return res.status(403).json({ error: "can only push state for your own consumer_id" });
    }
    const c = getConsumer(caller);
    if (!c) {
        ensureConsumer(caller);
    } else if (c.kind === "human") {
        return res.status(403).json({ error: "state push is for loop agents, not humans" });
    }
    const body = (req.body ?? {}) as { state?: unknown; human?: unknown; human_word?: unknown; cwd?: unknown; project?: unknown };
    if (body.state !== "busy" && body.state !== "idle" && body.state !== "boot") {
        return badRequest(res, "state must be one of: busy, idle, boot");
    }
    // #280: optional live human-presence flag pushed alongside the state.
    const human = typeof body.human === "boolean" ? body.human : undefined;
    // #310/#426/#619: optional presence word (stop/wait/boot/loop), mirrors
    // the bar. `ask` retired by #619 collapse ; `boot` added by #619 zm2ehq
    // for the launch-grace dedicated word.
    const humanWord =
        body.human_word === "stop" || body.human_word === "wait"
        || body.human_word === "boot" || body.human_word === "loop"
            ? body.human_word
            : undefined;
    // #393: optional loop root, pushed on each heartbeat → marks the project local.
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
    // #393 (Option A): optional loop project → exact root↔project attribution.
    const project = typeof body.project === "string" && body.project ? body.project : undefined;
    setConsumerState(caller, body.state, human, humanWord, cwd, project);
    // #1132 — heartbeat dedupe : only broadcast when something actually
    // changed. Loops re-push an identical state every heartbeat ; blasting
    // `consumer_changed` each time made every open browser tab refetch its
    // consumer surfaces per heartbeat per loop. Real flips (state / human
    // presence / word) still broadcast — and the SSE-close presence flip has
    // its own broadcast (live-presence.ts), so a killed loop still clears
    // live (#443).
    const changed = !c
        || c.state !== body.state
        || (human !== undefined && (c.state_human ?? null) !== human)
        || (humanWord !== undefined && (c.state_human_word ?? null) !== humanWord);
    if (changed) {
        broadcast({ type: "consumer_changed", data: { consumer_id: caller, state: body.state, human, human_word: humanWord } });
    }
    res.json({ consumer_id: caller, state: body.state, human, human_word: humanWord, cwd, project });
});

/**
 * #424: the Nodes panel feed — proxy-node tokens (kind='node') with label,
 * last activity, last peer IP, and the consumers each relays. Never exposes the
 * token value (a node is addressed by a non-secret `node_id`). Moderator-only,
 * like the other token-adjacent surfaces.
 */
consumersRouter.get("/nodes", (req: Request, res: Response) => {
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "nodes list is moderator-only" });
    }
    // #510 — décorer chaque node avec son état WS reverse courant. Lecture
    // mémoire (proxy-ws map) — pas de coût DB. Le NodeView reste compatible
    // back-compat ; les anciens clients ignorent le champ ws_state.
    // #2085 — plus the nodes revoked recently: the click that destroyed a
    // credential deserves a receipt, not a row quietly disappearing.
    const decorated = listNodesWithRevoked().map((n) => ({
        ...n,
        ws_state: n.revoked_at ? null : getProxyNodeWsState(n.node_id),
    }));
    res.json(decorated);
});

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
        });
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (enrollRateLimited(ip)) {
        return res.status(429).json({ error: "too many pairing requests — wait a minute" });
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
consumersRouter.get("/nodes/pairing", (req: Request, res: Response) => {
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "pairing window is moderator-only" });
    }
    res.json(pairingWindow());
});

consumersRouter.post("/nodes/pairing/:verb", (req: Request, res: Response) => {
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({ error: "pairing window is moderator-only" });
    }
    const verb = String(req.params.verb);
    if (verb !== "open" && verb !== "close") return badRequest(res, "verb must be open or close");
    if (verb === "close") {
        const w = closePairingWindow();
        broadcast({ type: "consumer_changed", data: { pairing_window: w } });
        return res.json(w);
    }
    const { minutes } = (req.body ?? {}) as { minutes?: unknown };
    const ms = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? minutes * 60_000
        : DEFAULT_PAIRING_WINDOW_MS;
    const w = openPairingWindow(caller, ms);
    broadcast({ type: "consumer_changed", data: { pairing_window: w } });
    res.json(w);
});

/** #2074 — the human side. Moderator-only, like every other node surface. */
consumersRouter.get("/nodes/enrollments", (req: Request, res: Response) => {
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "pairing requests are moderator-only" });
    }
    res.json(listEnrollments());
});

consumersRouter.post("/nodes/enrollments/:id/:verdict", (req: Request, res: Response) => {
    const caller = consumerOf(req);
    if (!isHuman(caller)) {
        return res.status(403).json({ error: "approving a node is moderator-only" });
    }
    const verdict = String(req.params.verdict);
    if (verdict !== "approve" && verdict !== "reject") {
        return badRequest(res, "verdict must be approve or reject");
    }
    const id = String(req.params.id);
    const view = verdict === "approve" ? approveEnrollment(id, caller) : rejectEnrollment(id, caller);
    // Null means the request was no longer decidable — expired, or already
    // decided. Saying so beats silently minting a second token.
    if (!view) return res.status(409).json({ error: "pairing request is no longer pending" });
    broadcast({ type: "consumer_changed", data: { enrollment: view } });
    res.json(view);
});

/** #424: revoke a node by its non-secret handle (deletes the underlying node
 *  token → the proxy can no longer relay). Moderator-only. */
consumersRouter.delete("/nodes/:node_id", (req: Request, res: Response) => {
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "node revoke is moderator-only" });
    }
    const node_id = String(req.params.node_id);
    if (!revokeNode(node_id, consumerOf(req))) return notFound(res, "node not found");
    broadcast({ type: "consumer_changed", data: { node_id, revoked: true } });
    res.json({ node_id, revoked: true });
});

