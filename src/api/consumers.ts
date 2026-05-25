/**
 * Consumer CRUD + state-push routes (#B.213 phase 1.B).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 * #B.79 consumer concept; #B.177 B1 state-push.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteConsumer,
    ensureConsumer,
    getConsumer,
    listConsumers,
    setConsumerState,
    updateConsumer,
    upsertConsumer,
    isHuman,
    type Consumer,
    type ConsumerKind,
} from "../db.js";
import { listNodes, revokeNode } from "../db/nodes.js";
import { broadcast } from "../ws.js";
import { badRequest, consumerOf, notFound } from "./_helpers.js";

export const consumersRouter = Router();

consumersRouter.get("/consumers", (_req, res) => {
    res.json(listConsumers());
});

// #397: single consumer lookup (incl. micro_prompt) — the claude-loop timer
// fetches its own row to inject `{consumer_prompt}` into the wake prompt.
consumersRouter.get("/consumers/:consumer_id", (req: Request, res: Response) => {
    const c = getConsumer(String(req.params.consumer_id));
    if (!c) return notFound(res, "consumer not found");
    res.json(c);
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
    };
    if (body.kind !== undefined && body.kind !== "human" && body.kind !== "agent" && body.kind !== "sandbox") {
        return badRequest(res, "kind must be 'human', 'agent', or 'sandbox'");
    }
    const patch: {
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
        micro_prompt?: string | null;
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
    // #310/#426: optional presence word (stop/wait/ask/loop), mirrors the bar.
    const humanWord =
        body.human_word === "stop" || body.human_word === "wait"
        || body.human_word === "ask" || body.human_word === "loop"
            ? body.human_word
            : undefined;
    // #393: optional loop root, pushed on each heartbeat → marks the project local.
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
    // #393 (Option A): optional loop project → exact root↔project attribution.
    const project = typeof body.project === "string" && body.project ? body.project : undefined;
    setConsumerState(caller, body.state, human, humanWord, cwd, project);
    broadcast({ type: "consumer_changed", data: { consumer_id: caller, state: body.state, human, human_word: humanWord } });
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
    res.json(listNodes());
});

/** #424: revoke a node by its non-secret handle (deletes the underlying node
 *  token → the proxy can no longer relay). Moderator-only. */
consumersRouter.delete("/nodes/:node_id", (req: Request, res: Response) => {
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "node revoke is moderator-only" });
    }
    const node_id = String(req.params.node_id);
    if (!revokeNode(node_id)) return notFound(res, "node not found");
    broadcast({ type: "consumer_changed", data: { node_id, revoked: true } });
    res.json({ node_id, revoked: true });
});
