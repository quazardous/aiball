import { Router, type Request, type Response } from "express";
import {
    getMessage,
    listProjects,
    listKnownAgents,
    getStrategy,
    setStrategy,
    getProjectStrategy,
    setProjectStrategy,
    STRATEGIES,
    INTENTS,
    type Intent,
    listProjectsDetailed,
    createProject,
    getProject,
    deleteProject,
    getProjectStatsRich,
    purgeOldClosedTickets,
    getProjectStats,
    type Strategy,
} from "./db.js";
import { existsSync, unlinkSync } from "node:fs";
import { broadcast } from "./ws.js";
import { outboxPath } from "./paths.js";
import { searchMessages } from "./search.js";
import { bearerAuth } from "./auth.js";
import { badRequest } from "./api/_helpers.js";
import { agentHelpersRouter } from "./api/agent-helpers.js";
import { authRouter } from "./api/auth.js";
import { consumersRouter } from "./api/consumers.js";
import { messagesRouter } from "./api/messages.js";
import { pingsRouter } from "./api/pings.js";
import { readTrackingRouter } from "./api/read-tracking.js";
import { rulesRouter } from "./api/rules.js";
import { subscriptionsRouter } from "./api/subscriptions.js";
import { tagsRouter } from "./api/tags.js";
import { ticketsRouter } from "./api/tickets.js";
import { ticketSubscriptionsRouter } from "./api/ticket-subscriptions.js";
import { uploadsRouter } from "./api/uploads.js";

export const api = Router();

// =====================================================================
// Auth middleware (#B.94)
// =====================================================================
// Mounted first so every other route gets req.consumer_id set from the
// bearer token. PUBLIC_PATHS bypass: /api/health, /api/auth/{setup,
// login,status}. Everything else needs a valid auth or agent token.
api.use(bearerAuth);

// =====================================================================
// /api/auth/* + /api/me — moved to ./api/auth.ts (#B.213 phase 1.E).
// =====================================================================
api.use(authRouter);

// =====================================================================
// Uploads + upload-max-bytes settings — moved to ./api/uploads.ts
// (#B.213 phase 1.E).
// =====================================================================
api.use(uploadsRouter);

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

// -------- messages -------------------------------------------------------
// All /messages routes (CRUD + moderation + decision-on-comment + #B.104
// question audit + #B.130 summarize + note) → ./api/messages.ts
// (#B.213 phase 1.F).
api.use(messagesRouter);

// -------- tickets (derived view) -------------------------------------------

api.get("/projects", (req, res) => {
    if (req.query.detailed === "1") {
        const consumer = req.query.consumer_id as string | undefined;
        return res.json(listProjectsDetailed(consumer));
    }
    res.json(listProjects());
});

/**
 * Register a project explicitly (#B.216 phase A pass 2). The CLI's
 * `aiball project init` and the Web UI's "Create project" button both
 * land here. Soft registry — no FK to tickets — but having a row means
 * the project shows up in listings before its first ticket is filed.
 *
 * Body: { name: string, display_name?: string, description?: string,
 *         created_by?: string }
 * 201 on success with the inserted row; 409 on duplicate name; 400 on
 * empty/whitespace name.
 */
api.post("/projects", (req, res) => {
    const raw = (req.body ?? {}) as {
        name?: unknown;
        display_name?: unknown;
        description?: unknown;
        created_by?: unknown;
    };
    if (typeof raw.name !== "string" || !raw.name.trim()) {
        return res.status(400).json({ error: "name is required" });
    }
    const name = raw.name.trim();
    if (/\s/.test(name)) {
        return res.status(400).json({ error: "name must not contain whitespace" });
    }
    if (getProject(name)) {
        return res.status(409).json({ error: `project ${name} already exists` });
    }
    const project = createProject({
        name,
        display_name: typeof raw.display_name === "string" ? raw.display_name : null,
        description: typeof raw.description === "string" ? raw.description : null,
        created_by: typeof raw.created_by === "string" ? raw.created_by : null,
    });
    res.status(201).json(project);
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

// -------- tickets ----------------------------------------------------------
// /tickets/bookends + /inbox + /tickets list + /tickets/:id and its
// sub-routes (mark-read/unread, postpone/unsnooze, relations, PATCH
// broadcast, brief/digest/full thread fetch) all moved to
// ./api/tickets.ts (#B.213 phase 1.G).
api.use(ticketsRouter);

// -------- consumers (#B.79) -----------------------------------------------
// Consumer CRUD + state-push moved to ./api/consumers.ts (#B.213 phase 1.B).
api.use(consumersRouter);

// -------- rules + agent helpers -------------------------------------------
// Moderation rule CRUD → ./api/rules.ts; /feed-path → ./api/agent-helpers.ts
// (#B.213 phase 1.C).
api.use(rulesRouter);
api.use(agentHelpersRouter);

// -------- subscriptions + read-tracking ------------------------------------
// Subscriptions CRUD → ./api/subscriptions.ts; read-state routes
// (unread, mark-read, my-pending/count) → ./api/read-tracking.ts.
// (#B.213 phase 1.D — split out the read-tracking routes that were
// previously bundled under the misleading "subscriptions" header.)
api.use(subscriptionsRouter);
api.use(readTrackingRouter);

// -------- tags ------------------------------------------------------------
// Tag CRUD + message-tag association moved to ./api/tags.ts (#B.213 phase 1.A).
api.use(tagsRouter);

// -------- pings + ticket subscriptions ------------------------------------
// Ping list/count/SSE/mark-read → ./api/pings.ts; per-ticket subscription
// CRUD → ./api/ticket-subscriptions.ts. (#B.213 phase 1.E)
api.use(pingsRouter);
api.use(ticketSubscriptionsRouter);
