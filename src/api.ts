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
    isRootActive,
    createProject,
    getProject,
    deleteProject,
    renameProject,
    getProjectStatsRich,
    purgeOldClosedTickets,
    getGlobalCounts,
    getProjectStats,
    isHuman,
    type Strategy,
    addProjectTokenUsage,
} from "./db.js";
import { captureTokenSnapshotIfDue, getTokenTimeseries } from "./db.js";
import { existsSync, unlinkSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { installRoot } from "./claude-loop/state.js";
import { broadcast } from "./ws.js";
import { outboxPath, AIBALL_HOME, DB_PATH, UPLOADS_DIR } from "./paths.js";
import { loadLaunchers, getLauncher } from "./launchers.js";
import { searchMessages } from "./search.js";
import { bearerAuth } from "./auth.js";
import { badRequest, consumerOf } from "./api/_helpers.js";
import { schedulerStatus } from "./cron/index.js";
import { AIBALL_VERSION } from "./version.js";
import { agentHelpersRouter } from "./api/agent-helpers.js";
import { authRouter } from "./api/auth.js";
import { consumersRouter } from "./api/consumers.js";
import { configRouter } from "./api/config.js";
import { messagesRouter } from "./api/messages.js";
import { pingsRouter } from "./api/pings.js";
import { readTrackingRouter } from "./api/read-tracking.js";
import { rulesRouter } from "./api/rules.js";
import { automationRouter } from "./api/automation.js";
import { agentsRouter } from "./api/agents.js";
import { subscriptionsRouter } from "./api/subscriptions.js";
import { tagsRouter } from "./api/tags.js";
import { ticketsRouter } from "./api/tickets.js";
import { workFiltersRouter } from "./api/work-filters.js";
import { managedConfigRouter } from "./api/managed-config.js";
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
    // #1566 — `cron` answers "why hasn't X run since 2am" without reading code:
    // per task, when it last ran, how long it took, what it last failed with,
    // and when it is next due. Empty outside the daemon (CLI / tests).
    res.json({
        ok: true,
        ts: new Date().toISOString(),
        version: AIBALL_VERSION,
        cron: schedulerStatus(),
    });
});

api.get("/strategy", (_req, res) => {
    res.json({ strategy: getStrategy() });
});

// #1200 — token usage over time. Lazy-captures a snapshot if the throttle
// window elapsed (so the series populates even without the boot job / restart),
// then returns the per-project series. Optional ?project= and ?days= scoping.
api.get("/token-usage/timeseries", (req: Request, res: Response) => {
    captureTokenSnapshotIfDue();
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const days = Number(req.query.days);
    const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined;
    res.json({ series: getTokenTimeseries({ project, sinceMs }) });
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

/**
 * #634 david `svzkpw` — push a turn's token-usage delta onto a PROJECT
 * (called by the claude-loop Stop-hook's no-marker fallback path).
 * Additive — accumulates. Body: `{ in?, out?, cache_w?, cache_r? }`.
 * Symmetric to POST /tickets/:id/token-usage.
 */
api.post("/projects/:project/token-usage", (req: Request, res: Response) => {
    const project = String(req.params.project ?? "");
    if (!project) return badRequest(res, "project required");
    const b = (req.body ?? {}) as { in?: unknown; out?: unknown; cache_w?: unknown; cache_r?: unknown };
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    addProjectTokenUsage(project, { in: n(b.in), out: n(b.out), cacheW: n(b.cache_w), cacheR: n(b.cache_r) });
    res.json({ project, ok: true });
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
        // #379: `&landscape=1` ajoute landscape_hash + landscape_last_activity
        // par projet (calcul O(N) gated → seul le timer claude-loop le demande).
        const landscape = req.query.landscape === "1";
        return res.json(listProjectsDetailed(consumer, landscape));
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

/**
 * #475 david : "danger zone globale pour purger les tickets fermés depuis
 * + 1 an". Same purge semantics as `/projects/:name/purge` but applied
 * to EVERY known project. Implementation walks `listProjects()` + calls
 * the per-project purge in sequence — keeps the cascade logic in one
 * place + emits the existing `project_purged` event per touched project
 * so other open tabs refresh counters incrementally as it sweeps.
 */
/**
 * #476 david : "ajout d'un zone information global — avec la taille des
 * data / image etc les infos etc". Daemon-wide info surfaced in Settings
 * > General > Info zone : aiball version, uptime, DB file size,
 * uploads directory size + file count, and global counts (projects /
 * tickets / messages). Read-only, single round-trip, called once on
 * panel mount.
 */
function dirSize(path: string): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    try {
        for (const ent of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, ent.name);
            if (ent.isDirectory()) {
                const sub = dirSize(child);
                bytes += sub.bytes;
                files += sub.files;
            } else if (ent.isFile()) {
                try { bytes += statSync(child).size; files += 1; } catch { /* race : file vanished */ }
            }
        }
    } catch { /* dir absent — return zeros */ }
    return { bytes, files };
}
api.get("/info", (_req, res) => {
    const counts = getGlobalCounts();
    let dbBytes = 0;
    try { dbBytes = statSync(DB_PATH).size; } catch { /* db absent — keep 0 */ }
    const uploads = dirSize(UPLOADS_DIR);
    res.json({
        version: AIBALL_VERSION,
        uptime_sec: Math.floor(process.uptime()),
        home: AIBALL_HOME,
        db: { path: DB_PATH, bytes: dbBytes },
        uploads: { path: UPLOADS_DIR, bytes: uploads.bytes, files: uploads.files },
        counts,
        ts: new Date().toISOString(),
    });
});

api.post("/tickets/purge", (req, res) => {
    const raw = (req.body ?? {}) as { older_than_days?: unknown };
    const days = typeof raw.older_than_days === "number" && raw.older_than_days > 0
        ? Math.floor(raw.older_than_days)
        : 365;
    const projects = listProjects();
    const per_project: Array<{ project: string; purged_tickets: number; purged_messages: number }> = [];
    let purged_tickets = 0;
    let purged_messages = 0;
    for (const p of projects) {
        const r = purgeOldClosedTickets(p, days);
        if (r.purged_tickets > 0) {
            broadcast({ type: "project_purged", data: { project: p, ...r, older_than_days: days } });
        }
        per_project.push({ project: p, ...r });
        purged_tickets += r.purged_tickets;
        purged_messages += r.purged_messages;
    }
    res.json({ older_than_days: days, purged_tickets, purged_messages, per_project, ok: true });
});

// #393 phase 4: launch a claude-loop for a known LOCAL root, from the UI.
// HUMAN-ONLY (it spawns a process) and restricted to a root this project has
// actually run on (consumers.cwd, pushed by a prior loop — #393 phase 1/2),
// never an arbitrary path. Spawns on THIS daemon's host; proxy-aware (#394):
// a launch hitting the remote daemon transparently forwards to the local node
// that owns the root, which spawns it there. Detached + --no-attach.
api.post("/projects/:name/launch", (req, res) => {
    const name = String(req.params.name);
    const caller = consumerOf(req);
    if (!caller || !isHuman(caller)) {
        return res.status(403).json({ error: "launch is human-only — it spawns a claude-loop process" });
    }
    const root = String(((req.body ?? {}) as { root?: unknown }).root ?? "");
    const meta = listProjectsDetailed().find((p) => p.name === name);
    const knownRoots = meta?.roots ?? [];
    if (!root || !knownRoots.includes(root)) {
        return badRequest(res, `root must be one of this project's known local roots: ${JSON.stringify(knownRoots)}`);
    }
    // #393 (3c): refuse a second loop at the same root — one is already running.
    if (isRootActive(root)) {
        return res.status(409).json({ error: "a claude-loop is already running for this root" });
    }
    try {
        const bin = join(installRoot(), "bin", "claude-loop");
        const child = spawn(bin, ["start", "--cwd", root, "--no-attach"], {
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        return res.json({ ok: true, project: name, root, pid: child.pid });
    } catch (e) {
        return res.status(500).json({ error: `failed to launch claude-loop: ${(e as Error).message}` });
    }
});

// #398: operator-approved command launchers. GET lists the declared launchers
// (config-only — see launchers.ts); POST runs one by id (HUMAN-ONLY, detached
// spawn). The API never accepts a command, only a launcher id → the daemon can
// only ever spawn what the operator declared in config.
api.get("/launchers", (_req, res) => {
    res.json(loadLaunchers());
});

api.post("/launchers/:id/run", (req, res) => {
    const caller = consumerOf(req);
    if (!caller || !isHuman(caller)) {
        return res.status(403).json({ error: "launchers are human-only — they spawn a process on the daemon host" });
    }
    const launcher = getLauncher(String(req.params.id));
    if (!launcher) {
        return res.status(404).json({ error: `no launcher with id '${req.params.id}' (declared in config?)` });
    }
    try {
        // Detached + stdio ignored → survives the daemon; inherits the user's
        // graphical-session env (WAYLAND_DISPLAY/DISPLAY/XDG_RUNTIME_DIR), so GUI
        // apps launch (#398 verified). cmd/args come from config, never the API.
        const child = spawn(launcher.cmd, launcher.args ?? [], {
            detached: true,
            stdio: "ignore",
            ...(launcher.cwd ? { cwd: launcher.cwd } : {}),
        });
        child.unref();
        return res.json({ ok: true, id: launcher.id, label: launcher.label, pid: child.pid });
    } catch (e) {
        return res.status(500).json({ error: `failed to launch '${launcher.id}': ${(e as Error).message}` });
    }
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
 * #699 — rename a project across every table that stores its name (cascade
 * via transactional UPDATEs). Body : `{ new_name: string }`. Returns the
 * per-table row counts so the caller can audit the cascade. 404 when the
 * old name doesn't exist, 409 when the new name collides.
 */
api.post("/projects/:name/rename", (req, res) => {
    const oldName = req.params.name;
    const newName = typeof req.body?.new_name === "string" ? req.body.new_name : "";
    if (!newName) return res.status(400).json({ error: "new_name required (string)" });
    try {
        const result = renameProject(oldName, newName);
        // Outbox file follows the project name — rename it too.
        try {
            const oldPath = outboxPath(oldName);
            const newPath = outboxPath(result.new_name);
            if (existsSync(oldPath)) {
                writeFileSync(newPath, "");
                unlinkSync(oldPath);
            }
        } catch {
            /* best-effort — DB is the source of truth */
        }
        broadcast({ type: "project_renamed", data: { old: result.old_name, new: result.new_name } });
        res.json({ ...result, ok: true });
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (msg.includes("does not exist")) return res.status(404).json({ error: msg });
        if (msg.includes("already exists")) return res.status(409).json({ error: msg });
        return res.status(400).json({ error: msg });
    }
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
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const hits = searchMessages(q, { project, open, intent, limit, since });
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

// -------- config home (#235) ----------------------------------------------
// `GET /api/config` is the single boot-time config read for the frontend:
// merged linkifier patterns (#B.235) + strategy + upload cap, in one call.
// Replaces the former one-router-per-config-slice drift (#cpd7zw). Config
// writes stay on their targeted PATCH endpoints.
api.use(configRouter);

// -------- rules + agent helpers -------------------------------------------
// Moderation rule CRUD → ./api/rules.ts; /feed-path → ./api/agent-helpers.ts
// (#B.213 phase 1.C).
api.use(rulesRouter);
api.use(workFiltersRouter);
// #457 — unified automation engine CRUD (separate URL prefix `/automation/*`
// so the legacy `/rules` + `/work-filters` keep serving their existing UI
// sections until slice 3 migrates them onto this engine).
api.use(automationRouter);
// #464 — live tmux/psmux pane mirror (SSE). Read-only ; one stream per
// open browser tab. Auth + bearer already gated upstream.
api.use(agentsRouter);
api.use(managedConfigRouter);
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
