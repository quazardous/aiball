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
    listKnownAgents,
    listUnread,
    unreadCount,
    pendingTicketsByAuthor,
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
    INTENTS,
    type Intent,
    insertPing,
    listPings,
    markPingsRead,
    unreadPingCount,
    upsertTicketSubscription,
    deleteTicketSubscription,
    listTicketSubscriptions,
    listProjectsDetailed,
    deleteProject,
    getProjectStatsRich,
    purgeOldClosedTickets,
    setTicketBroadcast,
    setTicketPostpone,
    getTicketPostpone,
    listExpiredPostpones,
    listSubTickets,
    subTicketCounts,
    getTicketStages,
    getTicketBookends,
    getMessageByHashid,
    markTicketSeen,
    markTicketUnseen,
    ticketUnreadFlags,
    deletePingsForMessage,
    getProjectStats,
    getUploadMaxBytes,
    setUploadMaxBytes,
    UPLOAD_HARD_CAP_BYTES,
    DEFAULT_UPLOAD_MAX_BYTES,
    insertUpload,
    uploadStats,
    listOrphanUploads,
    deleteUploadRow,
    type MessageKind,
    type MessageStatus,
    type Strategy,
    type Tag,
    type Message,
} from "./db.js";
import express from "express";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createHash } from "node:crypto";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";
import { outboxPath, UPLOADS_DIR } from "./paths.js";
import { searchMessages } from "./search.js";
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

// =====================================================================
//                  Uploads (per #B.76)
// =====================================================================

/**
 * Allowed MIME → file extension. Only types we trust to render
 * inline in an <img> through marked + DOMPurify. JPEG covers JPG.
 * SVG is intentionally OUT — it can carry script.
 */
const UPLOAD_MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};

/**
 * POST `/api/uploads` — accepts a raw image body keyed by `Content-Type`,
 * writes it content-addressable under `<AIBALL_HOME>/uploads/<sha256>.<ext>`,
 * returns `{ url, bytes, sha256 }`. The body must be the file bytes
 * directly (no multipart wrapper) — the frontend posts the Blob as the
 * fetch body with the right content-type. Cap is `getUploadMaxBytes()`,
 * defaulting to 10 MB (configurable via `/api/settings/upload-max-bytes`).
 *
 * Hash-addressable storage means duplicate uploads dedupe naturally and
 * the response URL doubles as a stable id for future referencing.
 */
api.post(
    "/uploads",
    // Use raw body parser scoped to this route so the global json parser
    // upstream doesn't try to eat the binary stream. The limit enforces
    // the hard cap; the per-setting limit is checked after parsing.
    express.raw({
        type: () => true,
        limit: UPLOAD_HARD_CAP_BYTES,
    }),
    (req: Request, res: Response) => {
        const ct = (req.header("content-type") ?? "").toLowerCase().split(";")[0].trim();
        const ext = UPLOAD_MIME_TO_EXT[ct];
        if (!ext) {
            return badRequest(
                res,
                `unsupported content-type "${ct}" — allowed: ${Object.keys(UPLOAD_MIME_TO_EXT).join(", ")}`,
            );
        }
        const buf = req.body as Buffer | undefined;
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            return badRequest(res, "empty body");
        }
        const max = getUploadMaxBytes();
        if (buf.length > max) {
            return res.status(413).json({
                error: `upload exceeds limit (${buf.length} > ${max} bytes)`,
                max_bytes: max,
                received_bytes: buf.length,
            });
        }
        const sha = createHash("sha256").update(buf).digest("hex");
        const filename = `${sha}.${ext}`;
        const target = joinPath(UPLOADS_DIR, filename);
        // Hash-addressable — if the file already exists, skip the write.
        // Two callers uploading the same bytes converge on a single file.
        if (!existsSync(target)) {
            writeFileSync(target, buf);
        }
        // Track in the uploads table so GC can find orphans later.
        // Idempotent: re-uploading the same bytes by a different author
        // keeps the first author on record (the first writer wins, no
        // need to mutate metadata).
        insertUpload({
            sha,
            ext,
            content_type: ct,
            bytes: buf.length,
            by_agent: consumerOf(req),
            original_name: typeof req.header("x-aiball-upload-name") === "string"
                ? req.header("x-aiball-upload-name")!.slice(0, 200)
                : null,
        });
        res.status(201).json({
            url: `/uploads/${filename}`,
            sha256: sha,
            bytes: buf.length,
            content_type: ct,
        });
    },
);

api.get("/uploads/stats", (_req, res) => {
    res.json(uploadStats());
});

/**
 * GC pass: find uploads not referenced anywhere in tickets / messages
 * bodies, delete both the on-disk file and the metadata row. A grace
 * window (default 5 min) protects very-recently-uploaded files that
 * the user hasn't yet pasted into a message.
 *
 * `dry_run: true` (or query `?dry_run=1`) only reports what would be
 * removed without touching anything.
 */
api.post("/uploads/gc", (req: Request, res: Response) => {
    const dryRun =
        req.body?.dry_run === true ||
        req.query.dry_run === "1" ||
        req.query.dry_run === "true";
    const graceMinutes = typeof req.body?.grace_minutes === "number"
        ? Math.max(0, req.body.grace_minutes)
        : 5;
    const orphans = listOrphanUploads(graceMinutes);
    let deletedFiles = 0;
    let freedBytes = 0;
    if (!dryRun) {
        for (const u of orphans) {
            const filename = `${u.sha}.${u.ext}`;
            const path = joinPath(UPLOADS_DIR, filename);
            try {
                if (existsSync(path)) {
                    unlinkSync(path);
                    deletedFiles += 1;
                    freedBytes += u.bytes;
                }
                deleteUploadRow(u.sha);
            } catch (e) {
                // Best-effort: log + keep going. A stale row left behind
                // is harmless; we'll retry next GC.
                console.error(`[uploads/gc] failed for ${filename}:`, e);
            }
        }
    }
    res.json({
        dry_run: dryRun,
        grace_minutes: graceMinutes,
        candidates: orphans.length,
        candidate_bytes: orphans.reduce((s, u) => s + u.bytes, 0),
        deleted_files: deletedFiles,
        freed_bytes: freedBytes,
        orphans: orphans.map((u) => ({
            sha: u.sha,
            ext: u.ext,
            bytes: u.bytes,
            by_agent: u.by_agent,
            created_at: u.created_at,
        })),
    });
});

api.get("/settings/upload-max-bytes", (_req, res) => {
    res.json({
        bytes: getUploadMaxBytes(),
        default: DEFAULT_UPLOAD_MAX_BYTES,
        hard_cap: UPLOAD_HARD_CAP_BYTES,
    });
});

api.patch("/settings/upload-max-bytes", (req: Request, res: Response) => {
    const { bytes } = (req.body ?? {}) as { bytes?: unknown };
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
        return badRequest(res, "bytes must be a positive number");
    }
    setUploadMaxBytes(bytes);
    res.json({
        bytes: getUploadMaxBytes(),
        default: DEFAULT_UPLOAD_MAX_BYTES,
        hard_cap: UPLOAD_HARD_CAP_BYTES,
    });
});

/**
 * Resolve the calling consumer from the `X-Aiball-Consumer` header. The UI
 * sets this once globally (from `localStorage.aiball.human_id ?? "human"`),
 * MCP/CLI clients can set it per-request, and we fall back to the
 * `AIBALL_HUMAN` env value (default `"human"`) so the daemon always has a
 * sensible default when nothing is provided. Per-consumer fields (read
 * state, unread flags, mark-read scope) read from this without each
 * handler having to ask for `consumer_id` in the query/body.
 */
function consumerOf(req: Request): string {
    const headerVal = req.header("x-aiball-consumer");
    if (typeof headerVal === "string" && headerVal.trim()) return headerVal.trim();
    return process.env.AIBALL_HUMAN ?? "human";
}

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
    try {
        const msg = submitMessage(v);
        return res.status(201).json(withTagsOne(msg));
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FORBIDDEN_CLOSE") {
            return res.status(403).json({ error: (err as Error).message });
        }
        throw err;
    }
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
    } else if (status === "rejected") {
        // At-insertion fan-out had already delivered pings to subscribers.
        // The message will never be approved, so wipe those pings so it
        // stops surfacing as unread on their inboxes.
        deletePingsForMessage(id);
    }
    // Transition ping: notify the message author that a moderator (human)
    // decided their submission. Skip if the author IS the moderator (close
    // the loop on bypass-humain posts that somehow ended up in the queue).
    if (
        updated.by_agent &&
        updated.by_agent !== "human" &&
        (status === "approved" || status === "rejected")
    ) {
        insertPing(updated.by_agent, updated);
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
    const { title, body, summary, intent } = req.body ?? {};
    if (
        title === undefined &&
        body === undefined &&
        summary === undefined &&
        intent === undefined
    ) {
        return badRequest(res, "provide title, body, summary, and/or intent");
    }
    if (intent !== undefined && intent !== null) {
        if (typeof intent !== "string" || !INTENTS.includes(intent as Intent)) {
            return badRequest(res, `intent must be one of ${INTENTS.join(", ")}`);
        }
    }
    const updated = editMessage(id, { title, body, summary, intent });
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
        const consumer = req.query.consumer_id as string | undefined;
        return res.json(listProjectsDetailed(consumer));
    }
    res.json(listProjects());
});

api.get("/projects/:name/stats", (req, res) => {
    res.json(getProjectStats(req.params.name));
});

/**
 * Mantis-style rich stats for the per-project page. Distinct from
 * /projects/:name/stats (the lightweight subscriber-count hint used
 * by ticket_new) — this one bundles pulse + live + top-N aggregates
 * for a dashboard view.
 */
api.get("/projects/:name/stats-rich", (req, res) => {
    res.json(getProjectStatsRich(req.params.name));
});

/**
 * Inbox bookends: oldest + newest non-rejected ticket matching the
 * scope. Used by the slim `poll()` (per #B.68) so agents see the
 * inbox edges without paying for the full subscriptions/projects blob.
 *
 * Query:
 *   - project=NAME    (optional) restrict to a project; otherwise cross-project.
 *   - include_snoozed=1  include snoozed tickets in the scope.
 */
api.get("/tickets/bookends", (req, res) => {
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const includeSnoozed = req.query.include_snoozed === "1";
    res.json(getTicketBookends({ project, includeSnoozed }));
});

/**
 * Autocomplete catalog for the composer's @-mentions (per #B.71).
 * Returns the projects + the distinct consumer_ids the daemon has seen,
 * so the composer can offer relevant completions when the user types @.
 * Lightweight read — called once at composer mount, cached client-side.
 */
api.get("/mention-suggestions", (_req, res) => {
    res.json({
        projects: listProjects(),
        agents: listKnownAgents(),
    });
});

api.post("/projects/:name/purge", (req, res) => {
    const name = req.params.name;
    const raw = (req.body ?? {}) as { older_than_days?: unknown };
    const days = typeof raw.older_than_days === "number" && raw.older_than_days > 0
        ? Math.floor(raw.older_than_days)
        : 365;
    const result = purgeOldClosedTickets(name, days);
    if (result.purged_tickets > 0) {
        broadcast({ type: "project_purged", data: { project: name, ...result, older_than_days: days } });
    }
    res.json({ project: name, older_than_days: days, ...result, ok: true });
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
api.get("/search", (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q.trim()) {
        return res.json([]);
    }
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const open = req.query.open === "1";
    const includePostponed = req.query.include_postponed === "1";
    const intentRaw = typeof req.query.intent === "string" ? req.query.intent : undefined;
    const intent = intentRaw && INTENTS.includes(intentRaw as Intent)
        ? (intentRaw as Intent)
        : undefined;
    const limit = typeof req.query.limit === "string"
        ? Number(req.query.limit) || undefined
        : undefined;
    const hits = searchMessages(q, { project, open, intent, limit });
    // Filter out hits whose parent ticket is currently snoozed, unless
    // the caller explicitly asked to see them. Cheap secondary pass.
    if (!includePostponed) {
        const nowStr = new Date().toISOString();
        const postponedTicketIds = new Set<number>();
        for (const h of hits) {
            const t = getMessage(h.ticket_id);
            if (
                t?.kind === "ticket_created" &&
                t.postponed_until &&
                t.postponed_until > nowStr
            ) {
                postponedTicketIds.add(h.ticket_id);
            }
        }
        res.json(hits.filter((h) => !postponedTicketIds.has(h.ticket_id)));
    } else {
        res.json(hits);
    }
});

api.get("/inbox", (req, res) => {
    const project = req.query.project as string | undefined;
    const status = req.query.status as MessageStatus | undefined;
    const onlyOpen = req.query.open === "1";
    const intentFilter = req.query.intent as string | undefined;
    // Include snoozed tickets in the open-inbox view (per #B.329). The
    // toggle in the header flips this on so a moderator can see what's
    // currently set aside. Default off — snoozed rows are hidden the
    // same way closed ones are.
    const includePostponed = req.query.include_postponed === "1";
    // Read state is per-consumer — resolved from the X-Aiball-Consumer
    // header (UI sets this once globally) with AIBALL_HUMAN fallback.
    // Each row gets an `unread` boolean computed from the pings table
    // (≥1 unseen ping on the thread for that consumer).
    const consumerId = consumerOf(req);

    const tickets = listMessages({ kind: "ticket_created", project });
    const otherMessages = listMessages({ project }).filter(
        (m) => m.kind !== "ticket_created",
    );

    interface Agg {
        commentCount: number;
        pendingCount: number;
        lastActivity: string;
        // Walk all approved lifecycle events in id order to derive the
        // current closed/resolved flags. Order matters because reopen
        // resets resolved.
        closed: boolean;
        resolved: boolean;
        // Surface pending ticket_resolved proposals so the reporter sees
        // in the list view that a thread is awaiting their accept/reject.
        // Only counts non-stale ones (we ignore them once the ticket is
        // closed since closing implicitly clears them).
        pendingResolution: boolean;
    }
    const byTicket = new Map<number, Agg>();
    // Sort lifecycle events for each ticket by id ASC so we can replay
    // them in order. Comments are tallied independently.
    const lifecycleByTicket = new Map<number, Message[]>();
    for (const m of otherMessages) {
        if (!m.ticket_id) continue;
        const cur =
            byTicket.get(m.ticket_id) ??
            ({
                commentCount: 0,
                pendingCount: 0,
                lastActivity: "",
                closed: false,
                resolved: false,
                pendingResolution: false,
            } as Agg);
        if (m.kind === "comment_added") {
            cur.commentCount++;
            if (m.status === "pending") cur.pendingCount++;
        }
        if (m.kind === "ticket_resolved" && m.status === "pending") {
            cur.pendingResolution = true;
        }
        if (
            (m.kind === "ticket_closed" ||
                m.kind === "ticket_reopened" ||
                m.kind === "ticket_resolved") &&
            m.status === "approved"
        ) {
            const list = lifecycleByTicket.get(m.ticket_id) ?? [];
            list.push(m);
            lifecycleByTicket.set(m.ticket_id, list);
        }
        if (m.created_at > cur.lastActivity) cur.lastActivity = m.created_at;
        byTicket.set(m.ticket_id, cur);
    }
    // Replay lifecycle events to compute final closed/resolved flags.
    for (const [tid, events] of lifecycleByTicket) {
        events.sort((a, b) => a.id - b.id);
        const cur = byTicket.get(tid)!;
        for (const ev of events) {
            if (ev.kind === "ticket_closed") cur.closed = true;
            else if (ev.kind === "ticket_reopened") {
                cur.closed = false;
                cur.resolved = false;
            } else if (ev.kind === "ticket_resolved") cur.resolved = true;
        }
    }

    const tagsMap = tagsForMessages(tickets.map((m) => m.id));
    const unreadMap = ticketUnreadFlags(consumerId, tickets.map((m) => m.id));
    const nowStr = new Date().toISOString();
    let rows = tickets.map((t) => {
        const agg =
            byTicket.get(t.id) ??
            ({
                commentCount: 0,
                pendingCount: 0,
                lastActivity: "",
                closed: false,
                resolved: false,
                pendingResolution: false,
            } as Agg);
        const postponedUntil = t.postponed_until ?? null;
        const postponed =
            !!postponedUntil && postponedUntil > nowStr;
        return {
            id: t.id,
            project: t.project,
            title: t.edited_title ?? t.title,
            summary: t.summary ?? null,
            body: t.edited_body ?? t.body,
            by_agent: t.by_agent,
            created_at: t.created_at,
            status: t.status,
            intent: t.intent,
            closed: agg.closed || t.status === "rejected",
            // Same rationale as the /tickets/:id handler: resolved stays
            // true after close so the UI can distinguish "closed because
            // resolved" from "closed without explicit resolution".
            resolved: agg.resolved,
            // True iff there is a pending ticket_resolved on this ticket
            // that the reporter still has to accept-and-close or reject.
            // Stays false once the ticket is closed (the close auto-promotes
            // any dangling pending resolved, see submitMessage).
            pending_resolution: agg.pendingResolution && !(agg.closed || t.status === "rejected"),
            broadcast: t.broadcast === 1,
            // Per-consumer unread flag (≥1 unseen ping on the thread for
            // the caller, resolved from the X-Aiball-Consumer header).
            unread: unreadMap.get(t.id) ?? false,
            // Snooze (#B.329). `postponed=true` means the deadline hasn't
            // passed yet — UI hides the row from the open inbox the same
            // way `closed=true` does. `postponed_until` is the deadline
            // itself, surfaced as a chip on the row when relevant.
            postponed,
            postponed_until: postponedUntil,
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
    if (onlyOpen) {
        rows = rows.filter((r) => !r.closed);
    }
    // Snooze filter applies on every status combination — not just when
    // `open=1`. Otherwise pending+snoozed tickets slip through (regression
    // surfaced after #B.78 enabled snoozing on pending tickets).
    if (!includePostponed) {
        rows = rows.filter((r) => !r.postponed);
    }
    if (intentFilter && intentFilter !== "all") {
        rows = rows.filter((r) => r.intent === intentFilter);
    }

    rows.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

    res.json(rows);
});

api.get("/tickets", (req, res) => {
    const project = req.query.project as string | undefined;
    const onlyOpen = req.query.open === "1";
    // Default: when `open=1`, snoozed tickets are hidden (same rule as
    // the inbox). Pass `include_postponed=1` to surface them anyway.
    const includePostponed = req.query.include_postponed === "1";
    // Tag filter — comma-separated names. AND semantics: a ticket must
    // carry EVERY listed tag to match. Unknown tag names are ignored
    // silently rather than 400'ing — keeps the URL lenient.
    const tagsFilter = typeof req.query.tags === "string"
        ? req.query.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    // Verbosity (#B.83 then #B.87 palier 2): default is summary now —
    // header-only payload, no body / edited_body. Pass `full=1` to
    // re-include bodies. `summary=1` kept as an accepted alias for
    // explicit-summary requests; `summary=0` forces full. The plain
    // default (neither flag) is summary.
    const fullParam = req.query.full;
    const summaryParam = req.query.summary;
    const summary =
        fullParam === "1"
            ? false
            : summaryParam === "0"
              ? false
              : true;
    // Author filter (#B.84): scope to tickets posted by a specific
    // consumer_id. Useful for "my tickets" without scanning the full list.
    const byAgent = typeof req.query.by_agent === "string" && req.query.by_agent
        ? req.query.by_agent
        : undefined;
    // Status filter (#B.84): default "approved" preserves prior behavior;
    // pass "pending" / "rejected" / "any" to widen.
    const statusParam = (req.query.status as string | undefined) ?? "approved";
    const statusFilter: "pending" | "approved" | "rejected" | undefined =
        statusParam === "pending" || statusParam === "approved" || statusParam === "rejected"
            ? statusParam
            : statusParam === "any"
              ? undefined
              : "approved";
    // Substring filter (#B.84): case-insensitive contains on the
    // (edited_)title. Cheap alternative to FTS when looking up a ticket
    // by name.
    const titleContains =
        typeof req.query.title_contains === "string" && req.query.title_contains
            ? req.query.title_contains.toLowerCase()
            : undefined;
    const limit =
        typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
            ? Math.max(1, Math.min(500, Number(req.query.limit)))
            : undefined;
    // since (#B.87): filter on ticket created_at >= since. Accepts any
    // string Date.parse() understands (ISO8601 recommended). Cheap
    // alternative to client-side diff when polling for new tickets.
    const sinceParam = typeof req.query.since === "string" ? req.query.since : undefined;
    const sinceIso = sinceParam && Number.isFinite(Date.parse(sinceParam))
        ? new Date(Date.parse(sinceParam)).toISOString()
        : undefined;

    const created = listMessages({
        status: statusFilter,
        kind: "ticket_created",
        project,
        by_agent: byAgent,
    });

    const closes = listMessages({
        status: "approved",
        kind: "ticket_closed",
        project,
    });
    const closedSet = new Set(closes.map((c) => c.ticket_id));
    const nowStr = new Date().toISOString();

    const tagsMap = tagsForMessages(created.map((m) => m.id));
    const childCounts = subTicketCounts(created.map((m) => m.id));
    const tickets = created.map((m) => {
        const postponedUntil = m.postponed_until ?? null;
        const postponed = !!postponedUntil && postponedUntil > nowStr;
        const base = {
            id: m.id,
            project: m.project,
            title: m.edited_title ?? m.title,
            // Agent-authored summary (#B.87). Falls back to title when
            // unset so consumers always have something printable.
            summary: m.summary ?? null,
            by_agent: m.by_agent,
            status: m.status,
            created_at: m.created_at,
            closed: closedSet.has(m.id),
            broadcast: m.broadcast === 1,
            postponed,
            postponed_until: postponedUntil,
            intent: m.intent,
            parent_ticket_id: m.parent_ticket_id ?? null,
            sub_ticket_count: childCounts.get(m.id) ?? 0,
            tags: tagsMap.get(m.id) ?? [],
        };
        if (summary) return base;
        return { ...base, body: m.edited_body ?? m.body };
    });

    let result = tickets;
    if (onlyOpen) {
        result = result.filter((t) => !t.closed && (includePostponed || !t.postponed));
    }
    if (tagsFilter && tagsFilter.length > 0) {
        const requiredSet = new Set(tagsFilter.map((s) => s.toLowerCase()));
        result = result.filter((t) => {
            const have = new Set((t.tags as { name: string }[]).map((tag) => tag.name.toLowerCase()));
            for (const need of requiredSet) if (!have.has(need)) return false;
            return true;
        });
    }
    if (titleContains) {
        result = result.filter((t) =>
            (t.title ?? "").toLowerCase().includes(titleContains),
        );
    }
    if (sinceIso) {
        result = result.filter((t) => t.created_at >= sinceIso);
    }
    if (limit !== undefined) result = result.slice(0, limit);
    res.json(result);
});

api.post("/tickets/:id/mark-read", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const r = markTicketSeen(consumerOf(req), id);
    res.json({ ticket_id: id, ...r });
});

api.post("/tickets/:id/mark-unread", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const r = markTicketUnseen(consumerOf(req), id);
    res.json({ ticket_id: id, ...r });
});

api.patch("/tickets/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const { broadcast: bcast } = req.body ?? {};
    if (typeof bcast !== "boolean") {
        return badRequest(res, "broadcast (boolean) required");
    }
    const ok = setTicketBroadcast(id, bcast);
    if (!ok) return notFound(res, "ticket not found");
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json(updated);
});

/**
 * Snooze a ticket (per #B.329). Body: `{ until: ISO8601 }` — the ticket
 * is hidden from the open inbox until that timestamp. The daemon's
 * reveal cron clears the field at the deadline and posts a synthetic
 * `ticket_reopened` so it bounces back.
 *
 * Owner / human-bypass is enforced: only the ticket reporter or the
 * human moderator can snooze. Other agents get a 403 to avoid surprise
 * "where did my ticket go" moments.
 */
api.post("/tickets/:id/postpone", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    const human = process.env.AIBALL_HUMAN ?? "human";
    if (caller !== human && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or the human moderator (${human}) can snooze this ticket`,
        });
    }
    const { until } = (req.body ?? {}) as { until?: unknown };
    if (typeof until !== "string" || !until) {
        return badRequest(res, "until (ISO8601 string) required");
    }
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed)) {
        return badRequest(res, `invalid until "${until}" — expected ISO8601`);
    }
    if (parsed <= Date.now()) {
        return badRequest(res, "until must be in the future");
    }
    const iso = new Date(parsed).toISOString();
    const ok = setTicketPostpone(id, iso);
    if (!ok) return notFound(res, "ticket not found");
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: iso });
});

api.post("/tickets/:id/unsnooze", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    const human = process.env.AIBALL_HUMAN ?? "human";
    if (caller !== human && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or the human moderator (${human}) can unsnooze this ticket`,
        });
    }
    setTicketPostpone(id, null);
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: null });
});

api.get("/tickets/:id", (req, res) => {
    // The :id param accepts either:
    //   - an integer ticket id (#B<id>) → resolved directly,
    //   - an integer comment id (legacy #C<id>) → resolved to parent thread
    //     with focus_message_id set,
    //   - a 6-char hashid string (canonical #C<hashid>) → looked up by
    //     hashid then resolved like an integer comment.
    const raw = req.params.id;
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    let requested: Message | null = null;
    if (numeric !== null) {
        requested = getMessage(numeric);
    }
    if (!requested) {
        requested = getMessageByHashid(raw);
    }
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
        focusMessageId = requested.id;
        t = parent;
    }
    const id = t.id;
    // Return tickets in any status so the moderator can open pending or
    // rejected ones from the inbox and act on them inline.
    const all = listMessages({ project: t.project });
    // Thread feed = comments + lifecycle events, inline. Lifecycle events
    // (close / reopen / resolved) are rendered as system rows in the UI so
    // the reader can see who flipped the state and when. Order: ASC by id.
    const threadMessages = all
        .filter(
            (m) =>
                m.ticket_id === id &&
                (m.kind === "comment_added" ||
                    m.kind === "ticket_closed" ||
                    m.kind === "ticket_reopened" ||
                    m.kind === "ticket_resolved" ||
                    m.kind === "ticket_sub_added" ||
                    m.kind === "ticket_referenced") &&
                m.status !== "rejected",
        )
        .sort((a, b) => a.id - b.id);
    // Lifecycle replay restricted to approved events for the header flags.
    const lifecycle = threadMessages.filter(
        (m) => m.kind !== "comment_added" && m.status === "approved",
    );
    let closedFlag = false;
    let resolvedFlag = false;
    let resolvedBy: string | null = null;
    let resolvedAt: string | null = null;
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") closedFlag = true;
        else if (ev.kind === "ticket_reopened") {
            closedFlag = false;
            resolvedFlag = false;
            resolvedBy = null;
            resolvedAt = null;
        } else if (ev.kind === "ticket_resolved") {
            resolvedFlag = true;
            resolvedBy = ev.by_agent;
            resolvedAt = ev.created_at;
        }
    }
    const closed = closedFlag || t.status === "rejected";
    // resolved stays true even after the ticket is closed — the UI uses the
    // pair (closed, resolved) to distinguish "closed because resolved" from
    // "closed without explicit resolution" (wontfix / abandoned / dup).
    // Reopen still zeroes resolvedFlag inside the replay loop.
    const resolved = resolvedFlag;
    // Verbosity (#B.87 palier 2): default is summary now — header only,
    // no body, no comments array. Pass `full=1` to opt back into the
    // full thread. Old `summary=0` accepted as the explicit override
    // for symmetry with /api/tickets.
    const fullThread =
        req.query.full === "1" || req.query.summary === "0";
    const summary = !fullThread;
    const headerBase = {
        id: t.id,
        project: t.project,
        title: t.edited_title ?? t.title,
        summary: t.summary ?? null,
        by_agent: t.by_agent,
        created_at: t.created_at,
        status: t.status,
        closed,
        resolved,
        resolved_by: resolved ? resolvedBy : null,
        resolved_at: resolved ? resolvedAt : null,
        broadcast: t.broadcast === 1,
        postponed_until: t.postponed_until ?? null,
        intent: t.intent,
        parent_ticket_id: t.parent_ticket_id ?? null,
        sub_tickets: listSubTickets(t.id),
        tags: listMessageTags(t.id),
    };
    if (summary) {
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return res.json({
            ticket: headerBase,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        });
    }
    res.json({
        ticket: {
            ...headerBase,
            body: t.edited_body ?? t.body,
        },
        comments: enrichRelationStages(withTags(threadMessages)),
        focus_message_id: focusMessageId,
    });
});

/**
 * Decorate ticket_referenced / ticket_sub_added pseudo-comments with the
 * `source_ticket_stage` of their target so the UI can render a small
 * state badge next to the ref (per #B.70 follow-up). Batched: one
 * lookup for every distinct source_ticket_id in the thread.
 */
function enrichRelationStages<T extends { id: number; kind: string; source_ticket_id?: number | null }>(comments: T[]): (T & { source_ticket_stage?: string })[] {
    const sourceIds = new Set<number>();
    for (const c of comments) {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            sourceIds.add(c.source_ticket_id);
        }
    }
    if (sourceIds.size === 0) return comments;
    const stages = getTicketStages([...sourceIds]);
    return comments.map((c) => {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            return { ...c, source_ticket_stage: stages.get(c.source_ticket_id) ?? "open" };
        }
        return c;
    });
}

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
    const { consumer_id, project, role } = req.body ?? {};
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (typeof project !== "string" || !project) {
        return badRequest(res, "project required");
    }
    let roleArg: "owner" | "follower" | undefined;
    if (role !== undefined && role !== null) {
        if (role !== "owner" && role !== "follower") {
            return badRequest(res, "role must be 'owner' or 'follower'");
        }
        roleArg = role;
    }
    const sub = upsertSubscription(consumer_id, project, roleArg);
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

api.get("/my-pending/count", (req, res) => {
    const by_agent = req.query.by_agent as string | undefined;
    if (!by_agent) return badRequest(res, "by_agent required");
    res.json({ by_agent, count: pendingTicketsByAuthor(by_agent) });
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
