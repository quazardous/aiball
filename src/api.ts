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
    markMessageSeen,
    markAllSeenForProject,
    markSeenUpToForProject,
    listTags,
    getTag,
    getTagByName,
    insertTag,
    updateTag,
    deleteTag,
    listMessageTags,
    addMessageTag,
    removeMessageTag,
    setMessageTags,
    tagsForMessages,
    getStrategy,
    setStrategy,
    STRATEGIES,
    insertPing,
    listPings,
    markPingsRead,
    unreadPingCount,
    upsertTicketSubscription,
    deleteTicketSubscription,
    listTicketSubscriptions,
    listProjectsDetailed,
    deleteProject,
    type MessageKind,
    type MessageStatus,
    type Strategy,
    type Tag,
    type Message,
} from "./db.js";
import { existsSync, unlinkSync } from "node:fs";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";
import { outboxPath } from "./paths.js";
import { fanOutPings, submitMessage, validateNewMessage, VALID_KINDS } from "./messages.js";

function badRequest(res: Response, msg: string): Response {
    return res.status(400).json({ error: msg });
}

function notFound(res: Response, msg = "not found"): Response {
    return res.status(404).json({ error: msg });
}

/**
 * Decorate one or many messages with their tags so callers can render
 * them without an N+1 round-trip. Uses one bulk SELECT regardless of
 * the number of messages.
 */
function withTags<T extends { id: number }>(rows: T[]): (T & { tags: Tag[] })[] {
    const map = tagsForMessages(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: map.get(r.id) ?? [] }));
}
function withTagsOne<T extends { id: number }>(row: T): T & { tags: Tag[] } {
    return { ...row, tags: listMessageTags(row.id) };
}

export const api = Router();

api.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

api.get("/strategy", (_req, res) => {
    res.json({ strategy: getStrategy() });
});

api.patch("/strategy", (req: Request, res: Response) => {
    const s = req.body?.strategy;
    if (typeof s !== "string" || !(STRATEGIES as readonly string[]).includes(s)) {
        return badRequest(res, `strategy must be one of ${STRATEGIES.join(", ")}`);
    }
    setStrategy(s as Strategy);
    broadcast({ type: "strategy_changed", data: { strategy: s } });
    res.json({ strategy: s });
});

// -------- messages ----------------------------------------------------------

api.post("/messages", (req: Request, res: Response) => {
    const v = validateNewMessage(req.body);
    if ("error" in v) return badRequest(res, v.error);
    const msg = submitMessage(v);
    return res.status(201).json(withTagsOne(msg));
});

api.get("/messages", (req: Request, res: Response) => {
    const { status, project, kind, by_agent, limit } = req.query;
    const list = listMessages({
        status: status as MessageStatus | undefined,
        project: project as string | undefined,
        kind: kind as MessageKind | undefined,
        by_agent: typeof by_agent === "string" ? by_agent : undefined,
        limit: limit ? Number(limit) : undefined,
    });
    res.json(withTags(list));
});

api.get("/messages/:id", (req, res) => {
    const m = getMessage(Number(req.params.id));
    if (!m) return notFound(res);
    res.json(withTagsOne(m));
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
        fanOutPings(updated);
    }
    // Transition ping: notify the message author that a moderator (human)
    // decided their submission. Skip if the author IS the moderator (close
    // the loop on bypass-humain posts that somehow ended up in the queue).
    if (
        updated.by_agent &&
        updated.by_agent !== "human" &&
        (status === "approved" || status === "rejected")
    ) {
        insertPing(updated.by_agent, updated.id);
    }
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_decided", data: decorated });
    res.json(decorated);
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
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    res.json(decorated);
});

api.post("/messages/:id/note", (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body ?? {};
    const updated = noteMessage(id, typeof note === "string" ? note : null);
    if (!updated) return notFound(res);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_noted", data: decorated });
    res.json(decorated);
});

// -------- tickets (derived view) -------------------------------------------

api.get("/projects", (req, res) => {
    if (req.query.detailed === "1") {
        return res.json(listProjectsDetailed());
    }
    res.json(listProjects());
});

api.delete("/projects/:name", (req, res) => {
    const name = req.params.name;
    const { deleted_messages } = deleteProject(name);
    // Best-effort outbox cleanup. If it fails (permission, race), we still
    // return success — the DB is the source of truth.
    try {
        const path = outboxPath(name);
        if (existsSync(path)) unlinkSync(path);
    } catch {
        /* ignore */
    }
    broadcast({ type: "project_deleted", data: { project: name, deleted_messages } });
    res.json({ project: name, deleted_messages, ok: true });
});

/**
 * Unified inbox view: one row per ticket, decorated with the latest activity
 * timestamp (so a new pending comment bumps its parent ticket to the top) and
 * with pending-comment counts so the moderator sees at a glance what needs
 * attention. Filter by status:
 *   - "pending"  → tickets that are themselves pending OR have ≥1 pending comment
 *   - "approved" → tickets with status=approved
 *   - "rejected" → tickets with status=rejected
 *   - undefined  → every ticket regardless of status
 */
api.get("/inbox", (req, res) => {
    const project = req.query.project as string | undefined;
    const status = req.query.status as MessageStatus | undefined;
    const onlyOpen = req.query.open === "1";
    const priorityFilter = req.query.priority as string | undefined;

    const tickets = listMessages({ kind: "ticket_created", project });
    const otherMessages = listMessages({ project }).filter(
        (m) => m.kind !== "ticket_created",
    );

    interface Agg {
        commentCount: number;
        pendingCount: number;
        lastActivity: string;
        // Track the latest approved lifecycle event (close or reopen) per
        // ticket. The closed state is the kind of that latest event.
        latestLifecycleId: number;
        latestLifecycleKind: "ticket_closed" | "ticket_reopened" | null;
    }
    const byTicket = new Map<number, Agg>();
    for (const m of otherMessages) {
        if (!m.ticket_id) continue;
        const cur =
            byTicket.get(m.ticket_id) ??
            ({
                commentCount: 0,
                pendingCount: 0,
                lastActivity: "",
                latestLifecycleId: 0,
                latestLifecycleKind: null,
            } as Agg);
        if (m.kind === "comment_added") {
            cur.commentCount++;
            if (m.status === "pending") cur.pendingCount++;
        }
        if (
            (m.kind === "ticket_closed" || m.kind === "ticket_reopened") &&
            m.status === "approved" &&
            m.id > cur.latestLifecycleId
        ) {
            cur.latestLifecycleId = m.id;
            cur.latestLifecycleKind = m.kind;
        }
        if (m.created_at > cur.lastActivity) cur.lastActivity = m.created_at;
        byTicket.set(m.ticket_id, cur);
    }

    const tagsMap = tagsForMessages(tickets.map((m) => m.id));
    let rows = tickets.map((t) => {
        const agg =
            byTicket.get(t.id) ??
            ({
                commentCount: 0,
                pendingCount: 0,
                lastActivity: "",
                latestLifecycleId: 0,
                latestLifecycleKind: null,
            } as Agg);
        return {
            id: t.id,
            project: t.project,
            title: t.edited_title ?? t.title,
            body: t.edited_body ?? t.body,
            by_agent: t.by_agent,
            created_at: t.created_at,
            status: t.status,
            priority: t.priority,
            closed: agg.latestLifecycleKind === "ticket_closed",
            comment_count: agg.commentCount,
            pending_comment_count: agg.pendingCount,
            last_activity:
                agg.lastActivity && agg.lastActivity > t.created_at
                    ? agg.lastActivity
                    : t.created_at,
            tags: tagsMap.get(t.id) ?? [],
        };
    });

    if (status === "pending") {
        rows = rows.filter((r) => r.status === "pending" || r.pending_comment_count > 0);
    } else if (status === "approved" || status === "rejected") {
        rows = rows.filter((r) => r.status === status);
    }
    if (onlyOpen) rows = rows.filter((r) => !r.closed);
    if (priorityFilter && priorityFilter !== "all") {
        rows = rows.filter((r) => r.priority === priorityFilter);
    }

    rows.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

    res.json(rows);
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

    const tagsMap = tagsForMessages(created.map((m) => m.id));
    const tickets = created.map((m) => ({
        id: m.id,
        project: m.project,
        title: m.edited_title ?? m.title,
        body: m.edited_body ?? m.body,
        by_agent: m.by_agent,
        created_at: m.created_at,
        closed: closedSet.has(m.id),
        priority: m.priority,
        tags: tagsMap.get(m.id) ?? [],
    }));

    res.json(onlyOpen ? tickets.filter((t) => !t.closed) : tickets);
});

api.get("/tickets/:id", (req, res) => {
    const requestedId = Number(req.params.id);
    const requested = getMessage(requestedId);
    if (!requested) return notFound(res, "ticket not found");
    // If the id is a comment (or close/reopen event), resolve up to its
    // parent ticket and attach `focus_message_id` so the UI can scroll to
    // the right place. Lets `#N` references in markdown be opened blindly.
    let t = requested;
    let focusMessageId: number | null = null;
    if (t.kind !== "ticket_created") {
        if (!t.ticket_id) return notFound(res, "ticket not found");
        const parent = getMessage(t.ticket_id);
        if (!parent || parent.kind !== "ticket_created") {
            return notFound(res, "ticket not found");
        }
        focusMessageId = requestedId;
        t = parent;
    }
    const id = t.id;
    // Return tickets in any status so the moderator can open pending or
    // rejected ones from the inbox and act on them inline.
    const all = listMessages({ project: t.project });
    const comments = all
        .filter(
            (m) =>
                m.kind === "comment_added" &&
                m.ticket_id === id &&
                m.status !== "rejected",
        )
        .reverse();
    // Closed state: kind of the latest approved close-or-reopen event for
    // this ticket, by id (events form an audit trail; the most recent one
    // wins). No event → not closed.
    const lifecycle = all
        .filter(
            (m) =>
                (m.kind === "ticket_closed" || m.kind === "ticket_reopened") &&
                m.ticket_id === id &&
                m.status === "approved",
        )
        .sort((a, b) => b.id - a.id);
    const closed = lifecycle.length > 0 && lifecycle[0].kind === "ticket_closed";
    res.json({
        ticket: {
            id: t.id,
            project: t.project,
            title: t.edited_title ?? t.title,
            body: t.edited_body ?? t.body,
            by_agent: t.by_agent,
            created_at: t.created_at,
            status: t.status,
            closed,
            priority: t.priority,
            tags: listMessageTags(t.id),
        },
        comments: withTags(comments),
        focus_message_id: focusMessageId,
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
        messages: withTags(messages),
    });
});

api.get("/unread/count", (req, res) => {
    const consumer_id = req.query.consumer_id as string | undefined;
    const project = req.query.project as string | undefined;
    if (!consumer_id || !project) {
        return badRequest(res, "consumer_id and project required");
    }
    res.json({
        consumer_id,
        project,
        count: unreadCount(consumer_id, project),
    });
});

api.post("/mark-read", (req: Request, res: Response) => {
    const { consumer_id, project, message_id, up_to_id, all } = req.body ?? {};
    if (typeof consumer_id !== "string") {
        return badRequest(res, "consumer_id required");
    }
    if (typeof message_id === "number") {
        const r = markMessageSeen(consumer_id, message_id);
        return res.json({ consumer_id, message_id, ...r });
    }
    if (typeof up_to_id === "number") {
        if (typeof project !== "string") {
            return badRequest(res, "project required when up_to_id is set");
        }
        const r = markSeenUpToForProject(consumer_id, project, up_to_id);
        return res.json({ consumer_id, project, up_to_id, ...r });
    }
    if (all === true) {
        if (typeof project !== "string") {
            return badRequest(res, "project required when all:true");
        }
        const r = markAllSeenForProject(consumer_id, project);
        return res.json({ consumer_id, project, ...r });
    }
    return badRequest(
        res,
        "provide message_id (single ack), up_to_id with project (bulk ack up to id), or all:true with project (ack everything delivered)",
    );
});

// -------- tags ------------------------------------------------------------

function resolveTagRef(ref: unknown): Tag | null {
    if (typeof ref === "number") return getTag(ref);
    if (typeof ref === "string") {
        return getTagByName(ref) ?? null;
    }
    return null;
}

api.get("/tags", (_req, res) => {
    res.json(listTags());
});

api.post("/tags", (req: Request, res: Response) => {
    const { name, color, note, position } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        return badRequest(res, "name required");
    }
    if (getTagByName(name.trim())) {
        return badRequest(res, `tag '${name}' already exists`);
    }
    const t = insertTag({
        name: name.trim(),
        color: typeof color === "string" ? color : null,
        note: typeof note === "string" ? note : null,
        position: typeof position === "number" ? position : 0,
    });
    broadcast({ type: "tag_changed", data: t });
    res.status(201).json(t);
});

api.patch("/tags/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { name, color, note, position } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return badRequest(res, "name must be a non-empty string");
    }
    if (typeof name === "string") {
        const conflict = getTagByName(name.trim());
        if (conflict && conflict.id !== id) {
            return badRequest(res, `tag '${name}' already exists`);
        }
    }
    const updated = updateTag(id, {
        name: typeof name === "string" ? name.trim() : undefined,
        color: color === null || typeof color === "string" ? color : undefined,
        note: note === null || typeof note === "string" ? note : undefined,
        position: typeof position === "number" ? position : undefined,
    });
    if (!updated) return notFound(res);
    broadcast({ type: "tag_changed", data: updated });
    res.json(updated);
});

api.delete("/tags/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!getTag(id)) return notFound(res);
    deleteTag(id);
    broadcast({ type: "tag_changed", data: { id, deleted: true } });
    res.status(204).end();
});

api.get("/messages/:id/tags", (req, res) => {
    const id = Number(req.params.id);
    if (!getMessage(id)) return notFound(res);
    res.json(listMessageTags(id));
});

api.put("/messages/:id/tags", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const { tag_ids, set_by } = req.body ?? {};
    if (!Array.isArray(tag_ids)) {
        return badRequest(res, "tag_ids must be an array of ids");
    }
    const ids: number[] = [];
    for (const r of tag_ids) {
        const tag = typeof r === "number" ? getTag(r) : getTagByName(String(r));
        if (!tag) return badRequest(res, `unknown tag: ${r}`);
        ids.push(tag.id);
    }
    setMessageTags(id, ids, typeof set_by === "string" ? set_by : null);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.json(tags);
});

api.post("/messages/:id/tags", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const { tag, set_by } = req.body ?? {};
    const t = resolveTagRef(tag);
    if (!t) return badRequest(res, `unknown tag: ${tag}`);
    addMessageTag(id, t.id, typeof set_by === "string" ? set_by : null);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.status(201).json(tags);
});

api.delete("/messages/:id/tags/:tag", (req, res) => {
    const id = Number(req.params.id);
    const m = getMessage(id);
    if (!m) return notFound(res);
    const tagRef = req.params.tag;
    const t =
        /^\d+$/.test(tagRef) ? getTag(Number(tagRef)) : getTagByName(tagRef);
    if (!t) return notFound(res, `unknown tag: ${tagRef}`);
    removeMessageTag(id, t.id);
    const tags = listMessageTags(id);
    broadcast({ type: "message_tagged", data: { message_id: id, tags } });
    res.json(tags);
});

// -------- pings ------------------------------------------------------------

api.get("/pings", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const pings = listPings({ recipient: consumer, unreadOnly, limit });
    res.json({ consumer_id: consumer, count: pings.length, pings });
});

api.get("/pings/count", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.json({ consumer_id: consumer, unread: unreadPingCount(consumer) });
});

api.post("/pings/mark-read", (req: Request, res: Response) => {
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

// -------- ticket subscriptions ---------------------------------------------

api.get("/ticket-subscriptions", (req, res) => {
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    res.json({
        consumer_id: consumer,
        subscriptions: listTicketSubscriptions(consumer),
    });
});

api.post("/ticket-subscriptions", (req: Request, res: Response) => {
    const consumer = req.body?.consumer_id as string | undefined;
    const ticket_id = req.body?.ticket_id;
    if (!consumer) return badRequest(res, "consumer_id required");
    if (typeof ticket_id !== "number") {
        return badRequest(res, "ticket_id required (number)");
    }
    const t = getMessage(ticket_id);
    if (!t || t.kind !== "ticket_created") {
        return notFound(res, "ticket not found");
    }
    upsertTicketSubscription(consumer, ticket_id);
    res.status(201).json({ consumer_id: consumer, ticket_id });
});

api.delete("/ticket-subscriptions/:ticket_id", (req, res) => {
    const ticket_id = Number(req.params.ticket_id);
    const consumer = req.query.consumer_id as string | undefined;
    if (!consumer) return badRequest(res, "consumer_id required");
    deleteTicketSubscription(consumer, ticket_id);
    res.json({ consumer_id: consumer, ticket_id, removed: true });
});
