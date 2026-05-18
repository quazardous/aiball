import { Router, type Request, type Response } from "express";
import {
    listMessages,
    getMessage,
    updateMessageStatus,
    editMessage,
    noteMessage,
    markQuestionAnswered,
    applyMessageDecision,
    reclassifyMessageDecision,
    setMessageSummary,
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
    getProjectStrategy,
    setProjectStrategy,
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
    markTicketSeenUpTo,
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
    listConsumers,
    getConsumer,
    ensureConsumer,
    upsertConsumer,
    updateConsumer,
    deleteConsumer,
    setConsumerState,
    isHuman,
    getPasswordHash,
    setPasswordHash,
    touchLastLogin,
    issueToken,
    getToken,
    deleteToken,
    listTokens,
    anyHumanCredentials,
    type Consumer,
    type ConsumerKind,
    type Token,
    type TokenKind,
    type MessageKind,
    type MessageStatus,
    type Strategy,
    type Tag,
    type Message,
    insertTypedRelation,
    listTypedRelationsForTicket,
    type ActiveRelation,
} from "./db.js";
import { onPing } from "./event-bus.js";
import { RELATION_KINDS, isRelationKind, type RelationKind } from "./relations.js";
import express from "express";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createHash } from "node:crypto";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";
import { outboxPath, UPLOADS_DIR } from "./paths.js";
import { searchMessages } from "./search.js";
import { fanOutPings, submitMessage, validateNewMessage, VALID_KINDS } from "./messages.js";
import { parseMeta } from "./questions.js";
import { isDecisionKind, type DecisionKind } from "./decisions.js";
import { bearerAuth, hashPassword, verifyPassword, type AuthenticatedRequest } from "./auth.js";

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
// Auth middleware (#B.94)
// =====================================================================
// Mounted first so every other route gets req.consumer_id set from the
// bearer token. PUBLIC_PATHS bypass: /api/health, /api/auth/{setup,
// login,status}. Everything else needs a valid auth or agent token.
api.use(bearerAuth);

// =====================================================================
// /api/auth/* — setup, login, logout, status
// =====================================================================

/**
 * GET /api/auth/status — public probe. Tells the frontend whether the
 * daemon needs an install token (first boot, no humans yet) or is in
 * normal "login required" mode.
 */
api.get("/auth/status", (req, res) => {
    const ready = anyHumanCredentials();
    const hasInstall = listTokens({ kind: "install" }).length > 0;
    // Best-effort detection of the caller's auth state — if they pass
    // a valid token, mention the consumer so the UI knows it's still
    // logged in.
    const tokenStr = (() => {
        const a = req.header("authorization");
        if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, "").trim();
        return req.header("x-aiball-token") ?? null;
    })();
    let me: { consumer_id: string; kind: TokenKind } | null = null;
    if (typeof tokenStr === "string" && tokenStr) {
        const t = getToken(tokenStr);
        if (t && t.kind !== "install" && t.consumer_id) {
            me = { consumer_id: t.consumer_id, kind: t.kind };
        }
    }
    res.json({
        ready,
        // True whenever a usable install token exists in the DB. Decoupled
        // from `ready` so that `aiball auth reinit` (which mints a fresh
        // install token even when humans already exist) reopens the
        // /setup path. The frontend uses this to decide whether to show
        // the setup form at all.
        install_available: hasInstall,
        me,
    });
});

/**
 * POST /api/auth/setup — consume the bootstrap install token to create
 * the first human consumer. Body: {token, consumer_id, password,
 * display_name?}.
 */
api.post("/auth/setup", async (req: Request, res: Response) => {
    const { token, consumer_id, password, display_name } = (req.body ?? {}) as {
        token?: unknown;
        consumer_id?: unknown;
        password?: unknown;
        display_name?: unknown;
    };
    if (typeof token !== "string" || !token) {
        return badRequest(res, "install token required");
    }
    if (typeof consumer_id !== "string" || !consumer_id || consumer_id.length > 64) {
        return badRequest(res, "consumer_id required (1-64 chars)");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(consumer_id)) {
        return badRequest(res, "consumer_id must contain only A-Za-z0-9._-");
    }
    if (typeof password !== "string" || password.length < 6) {
        return badRequest(res, "password required (min 6 chars)");
    }
    const installRow = getToken(token);
    if (!installRow || installRow.kind !== "install") {
        return res.status(401).json({ error: "invalid install token" });
    }
    // A valid install token is proof of CLI access (only `aiball auth
    // init/reinit` mints one). CLI access already grants full power
    // over the DB, so we allow overwriting an existing human's
    // password — this is exactly what `aiball auth reinit` is for.
    const hash = await hashPassword(password);
    upsertConsumer({
        consumer_id,
        kind: "human",
        display_name: typeof display_name === "string" && display_name ? display_name : null,
        enabled: true,
    });
    setPasswordHash(consumer_id, hash);
    touchLastLogin(consumer_id);
    // Consume the install token + issue a fresh auth token.
    deleteToken(token);
    const auth = issueToken({ consumer_id, kind: "auth", label: "web setup" });
    res.json({
        token: auth.token,
        consumer_id,
    });
});

/**
 * POST /api/auth/login — exchange login+password for an auth token.
 * Body: {consumer_id, password}. Returns {token, consumer_id} on success.
 */
api.post("/auth/login", async (req: Request, res: Response) => {
    const { consumer_id, password } = (req.body ?? {}) as {
        consumer_id?: unknown;
        password?: unknown;
    };
    if (typeof consumer_id !== "string" || !consumer_id) {
        return badRequest(res, "consumer_id required");
    }
    if (typeof password !== "string") {
        return badRequest(res, "password required");
    }
    const c = getConsumer(consumer_id);
    if (!c || !c.enabled || c.kind !== "human") {
        // Same response shape on failure to avoid revealing enumeration.
        return res.status(401).json({ error: "invalid credentials" });
    }
    const hash = getPasswordHash(consumer_id);
    if (!hash) return res.status(401).json({ error: "invalid credentials" });
    const ok = await verifyPassword(password, hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    touchLastLogin(consumer_id);
    const auth = issueToken({ consumer_id, kind: "auth", label: "web login" });
    res.json({
        token: auth.token,
        consumer_id,
    });
});

/**
 * POST /api/auth/logout — revoke the token used to authenticate.
 * Idempotent: succeeds even if the token is already gone.
 */
api.post("/auth/logout", (req: Request, res: Response) => {
    const a = req.header("authorization");
    let token: string | null = null;
    if (a && /^bearer\s+/i.test(a)) token = a.replace(/^bearer\s+/i, "").trim();
    if (!token) token = req.header("x-aiball-token") ?? null;
    if (token) deleteToken(token);
    res.json({ ok: true });
});

/**
 * GET /api/me — current authenticated consumer + display info. Useful
 * for the frontend to render "Hello, David" without an extra lookup.
 */
api.get("/me", (req: Request, res: Response) => {
    const id = consumerOf(req);
    const c = getConsumer(id);
    if (!c) return res.status(404).json({ error: "consumer not found" });
    res.json(c);
});

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
 * Resolve the calling consumer. After #B.94 this comes from the
 * `req.consumer_id` set by the bearer-token middleware (`src/auth.ts`).
 * Humans can still impersonate via `X-Aiball-Consumer` header — the
 * middleware already applied that override when valid.
 *
 * Final fallback to `AIBALL_HUMAN` env (default `"human"`) for routes
 * that are reached before the middleware fires (shouldn't happen, but
 * cheap defense in depth).
 */
function consumerOf(req: Request): string {
    const ar = req as AuthenticatedRequest;
    if (ar.consumer_id) return ar.consumer_id;
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

// Per-project strategy override (#B.127). Returns the project override
// (or null when unset) alongside the global, so the UI can render a
// "Use global (currently: X)" sentinel choice.
api.get("/projects/:project/strategy", (req: Request, res: Response) => {
    const project = String(req.params.project ?? "");
    if (!project) return badRequest(res, "project required");
    res.json({
        project,
        strategy: getProjectStrategy(project),
        global: getStrategy(),
    });
});

api.patch("/projects/:project/strategy", (req: Request, res: Response) => {
    const project = String(req.params.project ?? "");
    if (!project) return badRequest(res, "project required");
    const s = req.body?.strategy;
    // Pass null (or omit) to clear the override and fall back to global.
    if (s === null || s === undefined) {
        setProjectStrategy(project, null);
        broadcast({ type: "strategy_changed", data: { project, strategy: null } });
        return res.json({ project, strategy: null, global: getStrategy() });
    }
    if (typeof s !== "string" || !(STRATEGIES as readonly string[]).includes(s)) {
        return badRequest(res, `strategy must be one of ${STRATEGIES.join(", ")} or null`);
    }
    setProjectStrategy(project, s as Strategy);
    broadcast({ type: "strategy_changed", data: { project, strategy: s } });
    res.json({ project, strategy: s, global: getStrategy() });
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

/**
 * Mark a question on a message as answered (#B.104). Flips
 * `- [ ]<!-- q:<qid> -->` → `- [x]<!-- q:<qid> -->` in the parent's
 * body and records the audit in `meta.questions[<qid>]`.
 *
 *   POST /api/messages/:id/questions/:qid/answer
 *   body: { answered_by: string, answered_in: number }
 *
 * Idempotent — re-answering is a no-op. Broadcasts `message_edited`
 * on success so live clients see the toggle and the chip update.
 */
api.post("/messages/:id/questions/:qid/answer", (req, res) => {
    const id = Number(req.params.id);
    const qid = String(req.params.qid);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    if (!/^[a-zA-Z0-9_-]+$/.test(qid)) return badRequest(res, "invalid question id");
    const { answered_by, answered_in } = (req.body ?? {}) as {
        answered_by?: unknown;
        answered_in?: unknown;
    };
    if (typeof answered_by !== "string" || !answered_by) {
        return badRequest(res, "answered_by required");
    }
    if (typeof answered_in !== "number" || !Number.isFinite(answered_in)) {
        return badRequest(res, "answered_in (number) required");
    }
    const updated = markQuestionAnswered(id, qid, {
        answered_by,
        answered_at: new Date().toISOString(),
        answered_in,
    });
    if (!updated) return notFound(res);
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_edited", data: decorated });
    res.json(decorated);
});

/**
 * Decision-on-comment accept/reject (#B.129).
 *
 *   POST /api/messages/:id/decide
 *   body: { status: "accepted" | "rejected", decided_by?: string }
 *
 * The message must already carry a `meta.decision` block (the author
 * tagged it at post time via the composer dropdown). Idempotent —
 * re-applying the same status returns the row unchanged. Re-deciding
 * a terminal decision returns 409: the proper flow is to post a new
 * comment with a fresh decision (e.g. plan v2 after a rejected v1).
 */
api.post("/messages/:id/decide", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as {
        status?: unknown;
        decided_by?: unknown;
        new_kind?: unknown;
    };
    if (body.status !== "accepted" && body.status !== "rejected") {
        return badRequest(res, "status must be 'accepted' or 'rejected'");
    }
    const by = typeof body.decided_by === "string" && body.decided_by
        ? body.decided_by
        : consumerOf(req);
    // Optional reclassification (#B.129 follow-up).
    let newKind: DecisionKind | undefined;
    if (body.new_kind !== undefined && body.new_kind !== null) {
        if (typeof body.new_kind !== "string") {
            return badRequest(res, "new_kind must be a string when set");
        }
        if (!isDecisionKind(body.new_kind)) {
            return badRequest(res, "new_kind must be a valid decision kind");
        }
        newKind = body.new_kind;
    }
    try {
        const updated = applyMessageDecision(id, body.status, by, newKind);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        // Domain-level conflict (no decision present, or already
        // terminal) — surface as 409 so the UI can show the reason.
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * Set or clear a comment's one-line summary (#B.130 phase 1).
 *
 *   POST /api/messages/:id/summarize
 *   body: { summary: string }   (empty string clears)
 *
 * comment_added only. Caller permissioning is light — any participant
 * can summarize an existing comment (the audit is in updated_at, not
 * meta). Broadcasts `message_edited`.
 */
api.post("/messages/:id/summarize", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { summary?: unknown };
    if (typeof body.summary !== "string") {
        return badRequest(res, "summary (string) required");
    }
    try {
        const updated = setMessageSummary(id, body.summary);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
});

/**
 * Reclassify a comment's decision kind without flipping its status
 * (#B.129 follow-up — david: "je dois pouvoir requalifier en voici
 * mon plan"). Keeps the decision pending; just swaps `meta.decision
 * .kind` between `plan` and `resolution`.
 *
 *   POST /api/messages/:id/reclassify
 *   body: { new_kind: "plan" | "resolution" }
 *
 * HTTP 409 when the decision doesn't exist OR is already terminal.
 */
api.post("/messages/:id/reclassify", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return badRequest(res, "invalid message id");
    const body = (req.body ?? {}) as { new_kind?: unknown };
    if (typeof body.new_kind !== "string" || !isDecisionKind(body.new_kind)) {
        return badRequest(res, "new_kind must be a valid decision kind");
    }
    try {
        const updated = reclassifyMessageDecision(id, body.new_kind);
        if (!updated) return notFound(res);
        const decorated = withTagsOne(updated);
        broadcast({ type: "message_edited", data: decorated });
        res.json(decorated);
    } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
    }
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
        // Agent explicitly flagged "I can't proceed, human take over"
        // (#B.119). Independent of resolved — they signal different
        // intents to the reporter.
        blocked: boolean;
        // Surface pending ticket_resolved proposals so the reporter sees
        // in the list view that a thread is awaiting their accept/reject.
        // Only counts non-stale ones (we ignore them once the ticket is
        // closed since closing implicitly clears them).
        pendingResolution: boolean;
        // #B.168: latest comment id carrying a resolution decision —
        // used to honor "latest wins" when multiple resolution
        // comments coexist on the same thread.
        latestResolutionId: number;
        /** #B.168 follow-up: surface in the inbox row when the LAST
            resolution decision was rejected (so the reporter sees
            "yes I rejected it, the thread is open"). */
        latestResolutionRejected: boolean;
        // #B.173: same mechanic for plan decisions. David: "reject
        // plan est pas flag dans les list comme reject resolution".
        // Latest-wins symmetric with resolution.
        latestPlanId: number;
        latestPlanRejected: boolean;
        // #B.132: who spoke last on this thread. Tracks the by_agent
        // of the most recent non-rejected approved comment_added.
        // Falls back to the ticket creator if no comments yet.
        lastSpeaker: string | null;
        lastSpeakerId: number;
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
                blocked: false,
                pendingResolution: false,
                latestResolutionId: 0,
                latestResolutionRejected: false,
                latestPlanId: 0,
                latestPlanRejected: false,
                lastSpeaker: null,
                lastSpeakerId: 0,
            } as Agg);
        if (m.kind === "comment_added") {
            cur.commentCount++;
            if (m.status === "pending") cur.pendingCount++;
        }
        // #B.132: track who spoke last on this thread. Counts any
        // non-rejected message carrying content the human would read.
        // - `comment_added`: always (any status — even pending mod is
        //   "the author spoke, just not yet visible publicly").
        // - lifecycle events (`ticket_closed`/`reopened`/`resolved`/
        //   `blocked`): count when they carry a non-empty body (an
        //   explanation typed in the composer). Bare close/reopen
        //   with no body excluded — that's not speech.
        // System-only relations (`ticket_referenced` / `ticket_sub_added`)
        // never count.
        if (
            m.status !== "rejected" &&
            m.by_agent &&
            m.id > cur.lastSpeakerId &&
            (m.kind === "comment_added" ||
                (m.body &&
                    (m.kind === "ticket_closed" ||
                        m.kind === "ticket_reopened" ||
                        m.kind === "ticket_resolved" ||
                        m.kind === "ticket_blocked")))
        ) {
            cur.lastSpeaker = m.by_agent;
            cur.lastSpeakerId = m.id;
        }
        if (m.kind === "ticket_resolved" && m.status === "pending") {
            cur.pendingResolution = true;
        }
        // #B.129 phase 2: a comment carrying `meta.decision.kind ===
        // "resolution"` plays the same role as the legacy
        // ticket_resolved event. Latest-wins semantics (#B.168):
        // pending_resolution reflects whether the MOST RECENT
        // resolution-decision comment is still pending — older
        // pending proposals that the agent re-framed over time
        // shouldn't keep the flag stuck after the reporter rejected
        // the active one. otherMessages is sorted DESC by id, so the
        // FIRST resolution-decision comment we see is the latest;
        // skip subsequent ones via `latestResolutionId`. accepted →
        // synthetic resolved event for the replay below.
        let syntheticResolved: Message | null = null;
        if (m.kind === "comment_added" && m.status === "approved") {
            const meta = parseMeta(m.meta ?? null);
            const d = meta.decision;
            if (d?.kind === "resolution") {
                if (cur.latestResolutionId === 0 || m.id > cur.latestResolutionId) {
                    cur.latestResolutionId = m.id;
                    cur.pendingResolution = d.status === "pending";
                    cur.latestResolutionRejected = d.status === "rejected";
                }
                if (d.status === "accepted") {
                    syntheticResolved = { ...m, kind: "ticket_resolved" };
                }
            }
            // #B.173: same latest-wins for plan decisions. No
            // synthetic event — accepting a plan doesn't change the
            // ticket lifecycle (it just records "yes, that's the
            // direction"), only resolutions can close. Surface the
            // rejected state so the inbox row can flag it (parallel
            // to latest_resolution_rejected).
            if (d?.kind === "plan") {
                if (cur.latestPlanId === 0 || m.id > cur.latestPlanId) {
                    cur.latestPlanId = m.id;
                    cur.latestPlanRejected = d.status === "rejected";
                }
            }
        }
        if (
            (m.kind === "ticket_closed" ||
                m.kind === "ticket_reopened" ||
                m.kind === "ticket_resolved" ||
                m.kind === "ticket_blocked") &&
            m.status === "approved"
        ) {
            const list = lifecycleByTicket.get(m.ticket_id) ?? [];
            list.push(m);
            lifecycleByTicket.set(m.ticket_id, list);
        }
        if (syntheticResolved) {
            const list = lifecycleByTicket.get(m.ticket_id) ?? [];
            list.push(syntheticResolved);
            lifecycleByTicket.set(m.ticket_id, list);
        }
        if (m.created_at > cur.lastActivity) cur.lastActivity = m.created_at;
        byTicket.set(m.ticket_id, cur);
    }
    // Replay lifecycle events to compute final closed/resolved/blocked
    // flags. Reopen clears resolved + blocked alike (it's a "scratch
    // and restart" signal from the reporter).
    for (const [tid, events] of lifecycleByTicket) {
        events.sort((a, b) => a.id - b.id);
        const cur = byTicket.get(tid)!;
        for (const ev of events) {
            if (ev.kind === "ticket_closed") cur.closed = true;
            else if (ev.kind === "ticket_reopened") {
                cur.closed = false;
                cur.resolved = false;
                cur.blocked = false;
            } else if (ev.kind === "ticket_resolved") cur.resolved = true;
            else if (ev.kind === "ticket_blocked") cur.blocked = true;
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
                blocked: false,
                pendingResolution: false,
                latestResolutionId: 0,
                latestResolutionRejected: false,
                latestPlanId: 0,
                latestPlanRejected: false,
                lastSpeaker: null,
                lastSpeakerId: 0,
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
            // Agent-signalled "blocked, your call" (#B.119). Same rationale
            // as resolved: stays true after close so the UI can still show
            // *why* the ticket ended up closed.
            blocked: agg.blocked,
            // True iff there is a pending ticket_resolved on this ticket
            // that the reporter still has to accept-and-close or reject.
            // Stays false once the ticket is closed (the close auto-promotes
            // any dangling pending resolved, see submitMessage).
            pending_resolution: agg.pendingResolution && !(agg.closed || t.status === "rejected"),
            /** #B.168 follow-up: latest resolution was rejected →
                flag for a `× rejected` badge on the inbox row. Same
                suppression as pending_resolution (cleared once
                ticket is closed/rejected). */
            latest_resolution_rejected: agg.latestResolutionRejected && !(agg.closed || t.status === "rejected"),
            /** #B.173: same flag for plan decisions. David: reject
                plan wasn't surfaced in the list view the way reject
                resolution is. Symmetric to latest_resolution_rejected
                — cleared once the ticket is closed/rejected so the
                badge represents "live unresolved rejection". */
            latest_plan_rejected: agg.latestPlanRejected && !(agg.closed || t.status === "rejected"),
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
            // #B.132: who spoke last on this thread. Fallback to the
            // ticket creator when there are no comments yet — the
            // discrete "you spoke last" cue should still apply to
            // freshly created tickets the consumer just authored.
            last_speaker: agg.lastSpeaker ?? t.by_agent,
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
    // #B.191: optional `up_to_id` bounds the ack to pings whose target
    // message id is <= that value. Used by the ThreadView auto-mark on
    // dwell — captures the latest message id present at mount so any
    // comment arriving during the read window stays unread (and the
    // row stays bold+green in the inbox).
    const upToId = req.body?.up_to_id;
    if (typeof upToId === "number" && upToId > 0) {
        const r = markTicketSeenUpTo(consumerOf(req), id, upToId);
        return res.json({ ticket_id: id, up_to_id: upToId, ...r });
    }
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
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can snooze this ticket`,
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
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can unsnooze this ticket`,
        });
    }
    setTicketPostpone(id, null);
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: null });
});

// ---- Typed inter-ticket relations (#B.123 phase B) ------------------------
//
// Append-only events: POST creates a new ticket_relation row. To change a
// kind, POST a new event with the same target; the replay (listTypedRelations
// ForTicket) keeps only the latest per target. To remove, POST kind=ignored
// — acts as a tombstone in the replay. No PATCH/DELETE endpoint; the event
// log is the source of truth.

api.get("/tickets/:id/relations", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    res.json({ ticket_id: id, relations: listTypedRelationsForTicket(id) });
});

api.post("/tickets/:id/relations", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const body = (req.body ?? {}) as { target_ticket_id?: number; kind?: string };
    const target = Number(body.target_ticket_id);
    if (!Number.isFinite(target) || target <= 0) {
        return res.status(400).json({ error: "target_ticket_id required (positive integer)" });
    }
    if (target === id) {
        return res.status(400).json({ error: "a ticket cannot relate to itself" });
    }
    const kindStr = typeof body.kind === "string" ? body.kind : "";
    if (!isRelationKind(kindStr)) {
        return res.status(400).json({
            error: `kind must be one of ${RELATION_KINDS.join(", ")}`,
        });
    }
    const targetTicket = getMessage(target);
    if (!targetTicket || targetTicket.kind !== "ticket_created") {
        return res.status(404).json({ error: `target ticket #B.${target} not found` });
    }
    const caller = consumerOf(req);
    const event = insertTypedRelation({
        source_ticket_id: id,
        target_ticket_id: target,
        relation_kind: kindStr as RelationKind,
        by_agent: caller,
    });
    if (!event) return res.status(500).json({ error: "failed to create relation event" });
    broadcast({ type: "message_created", data: event });
    res.json({
        ticket_id: id,
        event_id: event.id,
        relations: listTypedRelationsForTicket(id),
    });
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
                    m.kind === "ticket_blocked" ||
                    m.kind === "ticket_sub_added" ||
                    m.kind === "ticket_referenced" ||
                    m.kind === "ticket_relation") &&
                m.status !== "rejected",
        )
        .sort((a, b) => a.id - b.id);
    // Lifecycle replay restricted to approved events for the header
    // flags. Since #B.129 phase 2, a comment_added with `meta.decision
    // .kind=="resolution"` and decision.status=="accepted" is replayed
    // as a synthetic ticket_resolved event at the comment's id, so
    // historical (legacy ticket_resolved kind) AND new (comment+decision)
    // shapes converge in the same replay.
    const lifecycle: Message[] = [];
    for (const m of threadMessages) {
        if (m.status !== "approved") continue;
        if (m.kind === "comment_added") {
            const d = parseMeta(m.meta ?? null).decision;
            if (d?.kind === "resolution" && d.status === "accepted") {
                lifecycle.push({
                    ...m,
                    kind: "ticket_resolved",
                    by_agent: d.decided_by ?? m.by_agent,
                    created_at: d.decided_at ?? m.created_at,
                });
            }
            continue;
        }
        lifecycle.push(m);
    }
    lifecycle.sort((a, b) => a.id - b.id);
    let closedFlag = false;
    let resolvedFlag = false;
    let resolvedBy: string | null = null;
    let resolvedAt: string | null = null;
    let blockedFlag = false;
    let blockedBy: string | null = null;
    let blockedAt: string | null = null;
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") closedFlag = true;
        else if (ev.kind === "ticket_reopened") {
            closedFlag = false;
            resolvedFlag = false;
            resolvedBy = null;
            resolvedAt = null;
            blockedFlag = false;
            blockedBy = null;
            blockedAt = null;
        } else if (ev.kind === "ticket_resolved") {
            resolvedFlag = true;
            resolvedBy = ev.by_agent;
            resolvedAt = ev.created_at;
        } else if (ev.kind === "ticket_blocked") {
            blockedFlag = true;
            blockedBy = ev.by_agent;
            blockedAt = ev.created_at;
        }
    }
    const closed = closedFlag || t.status === "rejected";
    // resolved stays true even after the ticket is closed — the UI uses the
    // pair (closed, resolved) to distinguish "closed because resolved" from
    // "closed without explicit resolution" (wontfix / abandoned / dup).
    // Reopen still zeroes resolvedFlag inside the replay loop.
    const resolved = resolvedFlag;
    // Same idea for blocked (#B.119): persists past close so the UI can
    // still tell "closed after agent escalation" from a normal resolve.
    const blocked = blockedFlag;
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
        blocked,
        blocked_by: blocked ? blockedBy : null,
        blocked_at: blocked ? blockedAt : null,
        broadcast: t.broadcast === 1,
        postponed_until: t.postponed_until ?? null,
        intent: t.intent,
        parent_ticket_id: t.parent_ticket_id ?? null,
        sub_tickets: listSubTickets(t.id),
        tags: listMessageTags(t.id),
        // #B.104: sidecar metadata (question-answer audit, etc.).
        // Frontend reads this to render the "X/Y open" chip beside
        // questions without round-tripping to the server.
        meta: t.meta ?? null,
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
    // #B.130 phase 2: brief mode. Returns the full ticket body PLUS
    // a `comments` array where each comment_added is replaced by a
    // slim header carrying `summary_until` (from meta.summary_until)
    // instead of the full body. The body is preserved on the LAST
    // comment so the reader still gets "current state". Lifecycle
    // events (closed / reopened / resolved / blocked / sub-added /
    // referenced) stay unchanged. No fallback: comments without
    // meta.summary_until surface as `summary_until: null` and the
    // consumer decides whether to refetch full.
    const brief = req.query.brief === "1";
    let outComments = enrichRelationStages(withTags(threadMessages));
    if (brief) {
        // Find the highest-id approved comment_added — its body is
        // always shipped in full so the reader sees the "now".
        let lastCommentId = 0;
        for (const m of threadMessages) {
            if (m.kind === "comment_added" && m.status === "approved" && m.id > lastCommentId) {
                lastCommentId = m.id;
            }
        }
        outComments = outComments.map((m) => {
            if (m.kind !== "comment_added" || m.id === lastCommentId) return m;
            const meta = parseMeta(m.meta ?? null);
            const summaryUntil = meta.summary_until ?? null;
            // Replacement is conditional on a summary being present.
            // Without it, dropping the body would silently swallow the
            // comment in brief reads — true for every human comment
            // (humans are exempted from the summary_until requirement)
            // AND for legacy pre-#B.130 agent comments. Keep the body
            // in that case so brief mode is lossy-by-summary, not
            // lossy-by-absence. The LAST comment's body is always
            // shipped (handled by the early-return above) so the
            // reader's "now" is always full.
            if (!summaryUntil) {
                return { ...m, summary_until: null } as typeof m;
            }
            return { ...m, body: null, edited_body: null, summary_until: summaryUntil } as typeof m;
        });
    }
    // #B.123 phase B: surface the active typed relations alongside the
    // existing parent/sub-ticket lineage. Each relation is enriched
    // with the target ticket's lifecycle stage (open / closed /
    // closed-resolved / rejected) so the chip can render a state
    // badge — david: "dans la nouvelle présentation on voit plus
    // l'état du ticket en relation".
    const typedRelations = listTypedRelationsForTicket(id);
    const targetStages = typedRelations.length > 0
        ? getTicketStages(typedRelations.map((r) => r.target_ticket_id))
        : new Map<number, string>();
    const typedRelationsWithStage = typedRelations.map((r) => ({
        ...r,
        target_stage: targetStages.get(r.target_ticket_id) ?? "open",
    }));
    res.json({
        ticket: {
            ...headerBase,
            body: t.edited_body ?? t.body,
            relations: typedRelationsWithStage,
        },
        comments: outComments,
        focus_message_id: focusMessageId,
        brief,
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

// -------- consumers (#B.79) -----------------------------------------------

api.get("/consumers", (_req, res) => {
    res.json(listConsumers());
});

api.post("/consumers", (req: Request, res: Response) => {
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

api.patch("/consumers/:consumer_id", (req: Request, res: Response) => {
    const consumer_id = String(req.params.consumer_id);
    const body = (req.body ?? {}) as {
        kind?: unknown;
        display_name?: unknown;
        enabled?: unknown;
        note?: unknown;
    };
    if (body.kind !== undefined && body.kind !== "human" && body.kind !== "agent" && body.kind !== "sandbox") {
        return badRequest(res, "kind must be 'human', 'agent', or 'sandbox'");
    }
    const patch: {
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
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
    const updated: Consumer | null = updateConsumer(consumer_id, patch);
    if (!updated) return notFound(res, "consumer not found");
    broadcast({ type: "consumer_changed", data: updated });
    res.json(updated);
});

api.delete("/consumers/:consumer_id", (req: Request, res: Response) => {
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
api.put("/consumers/:consumer_id/state", (req: Request, res: Response) => {
    const target = String(req.params.consumer_id);
    const caller = consumerOf(req);
    if (target !== caller) {
        return res.status(403).json({ error: "can only push state for your own consumer_id" });
    }
    const c = getConsumer(caller);
    if (!c) {
        // ensureConsumer + auto-set state — bootstrap when a loop
        // starts before the consumer has any post history.
        ensureConsumer(caller);
    } else if (c.kind === "human") {
        return res.status(403).json({ error: "state push is for loop agents, not humans" });
    }
    const body = (req.body ?? {}) as { state?: unknown };
    if (body.state !== "busy" && body.state !== "idle" && body.state !== "boot") {
        return badRequest(res, "state must be one of: busy, idle, boot");
    }
    setConsumerState(caller, body.state);
    broadcast({ type: "consumer_changed", data: { consumer_id: caller, state: body.state } });
    res.json({ consumer_id: caller, state: body.state });
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
 *   data: {"ticket_id":N}      // or {"comment_id":N}
 *
 *   :keepalive 30s              // SSE comment, ignored by parsers
 *
 * Keepalive every 30s prevents proxies/UDS buffers from killing the
 * idle stream. Client tears down the connection on its end.
 */
api.get("/events", (req, res) => {
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
    const ka = setInterval(() => {
        res.write(`:keepalive ${new Date().toISOString()}\n\n`);
    }, 30_000);
    const cleanup = () => {
        clearInterval(ka);
        off();
        try { res.end(); } catch { /* already closed */ }
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
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
