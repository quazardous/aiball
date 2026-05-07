import { Router, type Request, type Response } from "express";
import {
    listMessages,
    getMessage,
    updateMessageStatus,
    editMessage,
    noteMessage,
    listProjects,
    insertRule,
    listRules,
    deleteRule,
    setRuleEnabled,
    upsertSubscription,
    deleteSubscription,
    listSubscriptions,
    listUnread,
    unreadCount,
    markRead,
    markAllRead,
    type MessageKind,
    type MessageStatus,
} from "./db.js";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";
import { outboxPath } from "./paths.js";
import { submitMessage, validateNewMessage, VALID_KINDS } from "./messages.js";

function badRequest(res: Response, msg: string): Response {
    return res.status(400).json({ error: msg });
}

function notFound(res: Response, msg = "not found"): Response {
    return res.status(404).json({ error: msg });
}

export const api = Router();

api.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

// -------- messages ----------------------------------------------------------

api.post("/messages", (req: Request, res: Response) => {
    const v = validateNewMessage(req.body);
    if ("error" in v) return badRequest(res, v.error);
    const msg = submitMessage(v);
    return res.status(201).json(msg);
});

api.get("/messages", (req: Request, res: Response) => {
    const { status, project, kind, limit } = req.query;
    const list = listMessages({
        status: status as MessageStatus | undefined,
        project: project as string | undefined,
        kind: kind as MessageKind | undefined,
        limit: limit ? Number(limit) : undefined,
    });
    res.json(list);
});

api.get("/messages/:id", (req, res) => {
    const m = getMessage(Number(req.params.id));
    if (!m) return notFound(res);
    res.json(m);
});

function decide(
    req: Request,
    res: Response,
    status: MessageStatus,
): void | Response {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    if (existing.status !== "pending") {
        return badRequest(res, `message already ${existing.status}`);
    }
    const updated = updateMessageStatus(id, status, "human", null);
    if (!updated) return notFound(res);
    if (status === "approved") {
        deliverToOutbox(updated);
    }
    broadcast({ type: "message_decided", data: updated });
    res.json(updated);
}

api.post("/messages/:id/approve", (req, res) => decide(req, res, "approved"));
api.post("/messages/:id/reject", (req, res) => decide(req, res, "rejected"));

api.post("/messages/:id/edit", (req, res) => {
    const id = Number(req.params.id);
    const existing = getMessage(id);
    if (!existing) return notFound(res);
    const { title, body } = req.body ?? {};
    if (title === undefined && body === undefined) {
        return badRequest(res, "provide title and/or body");
    }
    const updated = editMessage(id, { title, body });
    if (!updated) return notFound(res);
    broadcast({ type: "message_edited", data: updated });
    res.json(updated);
});

api.post("/messages/:id/note", (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body ?? {};
    const updated = noteMessage(id, typeof note === "string" ? note : null);
    if (!updated) return notFound(res);
    broadcast({ type: "message_noted", data: updated });
    res.json(updated);
});

// -------- tickets (derived view) -------------------------------------------

api.get("/projects", (_req, res) => {
    res.json(listProjects());
});

api.get("/tickets", (req, res) => {
    const project = req.query.project as string | undefined;
    const onlyOpen = req.query.open === "1";

    const created = listMessages({
        status: "approved",
        kind: "ticket_created",
        project,
    });

    const closes = listMessages({
        status: "approved",
        kind: "ticket_closed",
        project,
    });
    const closedSet = new Set(closes.map((c) => c.ticket_id));

    const tickets = created.map((m) => ({
        id: m.id,
        project: m.project,
        title: m.edited_title ?? m.title,
        body: m.edited_body ?? m.body,
        by_agent: m.by_agent,
        created_at: m.created_at,
        closed: closedSet.has(m.id),
    }));

    res.json(onlyOpen ? tickets.filter((t) => !t.closed) : tickets);
});

api.get("/tickets/:id", (req, res) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created" || t.status !== "approved") {
        return notFound(res, "ticket not found or not approved");
    }
    const all = listMessages({ status: "approved", project: t.project });
    const comments = all
        .filter((m) => m.kind === "comment_added" && m.ticket_id === id)
        .reverse();
    const closed = all.some(
        (m) => m.kind === "ticket_closed" && m.ticket_id === id,
    );
    res.json({
        ticket: {
            id: t.id,
            project: t.project,
            title: t.edited_title ?? t.title,
            body: t.edited_body ?? t.body,
            by_agent: t.by_agent,
            created_at: t.created_at,
            closed,
        },
        comments,
    });
});

// -------- rules ------------------------------------------------------------

api.get("/rules", (_req, res) => {
    res.json(listRules());
});

api.post("/rules", (req: Request, res: Response) => {
    const { decision, match_project, match_kind, match_by_agent, position, note } =
        req.body ?? {};
    if (decision !== "auto" && decision !== "review") {
        return badRequest(res, "decision must be 'auto' or 'review'");
    }
    if (match_kind && !VALID_KINDS.includes(match_kind)) {
        return badRequest(res, `match_kind must be one of ${VALID_KINDS.join(", ")}`);
    }
    const r = insertRule({
        decision,
        match_project: match_project ?? null,
        match_kind: match_kind ?? null,
        match_by_agent: match_by_agent ?? null,
        position: typeof position === "number" ? position : 0,
        note: note ?? null,
    });
    broadcast({ type: "rule_changed", data: r });
    res.status(201).json(r);
});

api.delete("/rules/:id", (req, res) => {
    deleteRule(Number(req.params.id));
    broadcast({ type: "rule_changed", data: { id: Number(req.params.id), deleted: true } });
    res.status(204).end();
});

api.patch("/rules/:id", (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
        return badRequest(res, "only `enabled: boolean` supported for now");
    }
    const r = setRuleEnabled(Number(req.params.id), enabled);
    if (!r) return notFound(res);
    broadcast({ type: "rule_changed", data: r });
    res.json(r);
});

// -------- helpers for agents ----------------------------------------------

api.get("/feed-path", (req, res) => {
    const project = req.query.project as string | undefined;
    if (!project) return badRequest(res, "project query required");
    try {
        res.json({ path: outboxPath(project) });
    } catch (e) {
        return badRequest(res, (e as Error).message);
    }
});

// -------- subscriptions ---------------------------------------------------

api.post("/subscriptions", (req: Request, res: Response) => {
    const { consumer_id, project, catchup } = req.body ?? {};
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (typeof project !== "string" || !project) {
        return badRequest(res, "project required");
    }
    const sub = upsertSubscription(consumer_id, project, catchup === true);
    res.status(201).json(sub);
});

api.get("/subscriptions", (req: Request, res: Response) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    res.json(listSubscriptions(consumer_id));
});

api.delete("/subscriptions", (req: Request, res: Response) => {
    const { consumer_id, project } = req.query;
    if (typeof consumer_id !== "string" || typeof project !== "string") {
        return badRequest(res, "consumer_id and project query params required");
    }
    deleteSubscription(consumer_id, project);
    res.status(204).end();
});

api.get("/unread", (req: Request, res: Response) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = req.query.project as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    if (!consumer_id || !project) {
        return badRequest(res, "consumer_id and project required");
    }
    const messages = listUnread(consumer_id, project, limit);
    res.json({
        consumer_id,
        project,
        count: unreadCount(consumer_id, project),
        messages,
    });
});

api.post("/mark-read", (req: Request, res: Response) => {
    const { consumer_id, project, up_to_id, all } = req.body ?? {};
    if (typeof consumer_id !== "string" || typeof project !== "string") {
        return badRequest(res, "consumer_id and project required");
    }
    let sub;
    if (all === true) {
        sub = markAllRead(consumer_id, project);
    } else if (typeof up_to_id === "number") {
        sub = markRead(consumer_id, project, up_to_id);
    } else {
        return badRequest(res, "provide up_to_id (number) or all:true");
    }
    if (!sub) return notFound(res, "subscription not found — call POST /subscriptions first");
    res.json(sub);
});
