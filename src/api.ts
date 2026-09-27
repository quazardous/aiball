import { serveMethod } from "./bus/http.js";
import { Router } from "express";
import { bearerAuth } from "./auth.js";
import { schedulerStatus } from "./cron/index.js";
import { AIBALL_VERSION } from "./version.js";
import { agentHelpersRouter } from "./api/agent-helpers.js";
import { authRouter } from "./api/auth.js";
import { consumersRouter } from "./api/consumers.js";
import { configRouter } from "./api/config.js";
import { messagesRouter } from "./api/messages.js";
import { payloadsRouter } from "./api/payloads.js";
import { pingsRouter } from "./api/pings.js";
import { signalsRouter } from "./api/signals.js";
import { keyTicketsRouter } from "./api/key-tickets.js";
import { signalKeysRouter } from "./api/signal-keys.js";
import { readTrackingRouter } from "./api/read-tracking.js";
import { automationRouter } from "./api/automation.js";
import { agentsRouter } from "./api/agents.js";
import { subscriptionsRouter } from "./api/subscriptions.js";
import { tagsRouter } from "./api/tags.js";
import { ticketsRouter } from "./api/tickets.js";
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
// Uploads — ./api/uploads.ts; the upload cap is a bus method (upload.max_bytes).
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

/**
 * #2089 — ask the daemon to reload its config, in band.
 *
 * `aiball reload` used to be a SIGUSR2 to the pidfile. Signals do not exist on
 * Windows, where `process.kill` ignores the name and terminates the target — so
 * the one command that promises "no downtime" was the one that stopped the
 * daemon. This route is the mechanism that exists on both platforms; the signal
 * stays as its Linux plumbing.
 *
 * LOCAL-TRUST, not moderator: the mechanism it replaces was a signal to the
 * pidfile, which anyone running as the same uid could send — and gating on
 * `isHuman` broke exactly that, since a CLI run inside a project resolves to
 * that project's agent and got a 403. The Unix socket IS that same-uid
 * boundary, so it is the honest equivalent. A remote caller cannot reload,
 * which also matches what it replaces: you needed the pidfile, locally.
 *
 * It deserves no more than that: it re-reads a config file and reports what it
 * read. It mints nothing, exposes nothing, and cannot fail in a way that takes
 * the daemon down.
 */
api.post("/daemon/reload", serveMethod("daemon.reload"));

api.get("/strategy", serveMethod("strategy.get"));

// #1200 — token usage over time. Lazy-captures a snapshot if the throttle
// window elapsed (so the series populates even without the boot job / restart),
// then returns the per-project series. Optional ?project= and ?days= scoping.
api.get("/token-usage/timeseries", serveMethod("token_usage.timeseries"));

api.patch("/strategy", serveMethod("strategy.set"));

// Per-project strategy override (#B.127). Returns the project override
// (or null when unset) alongside the global, so the UI can render a
// "Use global (currently: X)" sentinel choice.
api.get("/projects/:project/strategy", serveMethod("project.strategy"));

api.patch("/projects/:project/strategy", serveMethod("project.set_strategy"));

// #1819 — the facts an agent needs to judge whether a human is around, with
// no verdict derived from them. Elapsed time rather than a boolean, because
// the threshold depends on what the agent is about to commit, and that
// knowledge lives in the agent, not here.
api.get("/presence", serveMethod("consumer.presence"));

// #1832 — the project's standing instruction, shown at the head of every wake.
// Mirrors the per-project strategy pair above: GET returns the current value,
// PATCH sets it, and passing null (or an empty string) clears it.
//
// No length cap here on purpose. Brevity is carried by the UI using a
// single-line text input rather than a textarea — david's call, so that the
// widget reminds him to stay short instead of a validator rejecting a paste
// after the fact.

api.get("/projects/:project/standing-prompt", serveMethod("project.standing_prompt"));

// #2770 — the open ticket of the project holding back the most open tickets,
// for the loop to name before its backlog. An indicator: nothing acts on it.
api.get("/projects/:project/critical", serveMethod("project.critical"));

// #2910 — a project's milestones, oldest first: state (open / released) and
// progress. Readable by every consumer, coders included.
api.get("/projects/:project/milestones", serveMethod("project.milestones"));

api.patch("/projects/:project/standing-prompt", serveMethod("project.set_standing_prompt"));

/**
 * #634 david `svzkpw` — push a turn's token-usage delta onto a PROJECT
 * (called by the claude-loop Stop-hook's no-marker fallback path).
 * Additive — accumulates. Body: `{ in?, out?, cache_w?, cache_r? }`.
 * Symmetric to POST /tickets/:id/token-usage.
 */
api.post("/projects/:project/token-usage", serveMethod("project.add_token_usage"));

// -------- messages -------------------------------------------------------
// All /messages routes (CRUD + moderation + decision-on-comment + #B.104
// question audit + #B.130 summarize + note) → ./api/messages.ts
// (#B.213 phase 1.F).
api.use(messagesRouter);

// -------- tickets (derived view) -------------------------------------------

api.get("/projects", serveMethod("project.list"));

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
api.post("/projects", serveMethod("project.create", undefined, { status: 201 }));

// #2629 — declared step delays against when the agent actually came back.
api.get("/steps/timing", serveMethod("step.timing"));


api.get("/projects/:name/stats", serveMethod("project.stats"));

/**
 * Mantis-style rich stats for the per-project page. Distinct from
 * /projects/:name/stats (the lightweight subscriber-count hint used
 * by ticket_new) — this one bundles pulse + live + top-N aggregates
 * for a dashboard view.
 */
api.get("/projects/:name/stats-rich", serveMethod("project.stats_rich"));

/**
 * Autocomplete catalog for the composer's @-mentions (per #B.71).
 * Returns the projects + the distinct consumer_ids the daemon has seen,
 * so the composer can offer relevant completions when the user types @.
 * Lightweight read — called once at composer mount, cached client-side.
 */
api.get("/mention-suggestions", serveMethod("mention.suggestions"));

api.post("/projects/:name/purge", serveMethod("project.purge"));

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
api.get("/info", serveMethod("board.info"));

api.post("/tickets/purge", serveMethod("board.purge"));

// #393 phase 4: launch a claude-loop for a known LOCAL root, from the UI.
// HUMAN-ONLY (it spawns a process) and restricted to a root this project has
// actually run on (consumers.cwd, pushed by a prior loop — #393 phase 1/2),
// never an arbitrary path. Spawns on THIS daemon's host; proxy-aware (#394):
// a launch hitting the remote daemon transparently forwards to the local node
// that owns the root, which spawns it there. Detached + --no-attach.
api.post("/projects/:name/launch", serveMethod("project.launch"));

// #398: operator-approved command launchers. GET lists the declared launchers
// (config-only — see launchers.ts); POST runs one by id (HUMAN-ONLY, detached
// spawn). The API never accepts a command, only a launcher id → the daemon can
// only ever spawn what the operator declared in config.
api.get("/launchers", serveMethod("launcher.list"));

api.post("/launchers/:id/run", serveMethod("launcher.run"));

// #1992 — the compiled graph. Both routes recompile lazily when the message log
// has moved (~320 ms on the whole corpus) and report that in `freshness`, so a
// caller can tell a fresh answer from a cached one instead of guessing.
//
// The graph is compiled corpus-wide, because references cross projects and a
// per-project compile could not see them. What each consumer READS is a
// projection of it: their own projects in full, and past that only the fact
// that a link crosses. Hence `consumerId` on both calls — without it these
// routes returned another project's ticket titles to anyone who asked.
api.get("/graph/neighbors", serveMethod("graph.neighbors"));

api.get("/graph/audit", serveMethod("graph.audit"));

api.get("/search", serveMethod("message.search"));

// -------- tickets ----------------------------------------------------------
// /tickets/bookends + /inbox + /tickets list + /tickets/:id and its
// sub-routes (mark-read/unread, postpone/unsnooze, relations, PATCH
// broadcast, brief/digest/full thread fetch) all moved to
// ./api/tickets.ts (#B.213 phase 1.G).
api.use(payloadsRouter);
// #2526 — POST /api/tickets, for an API key with the scope tickets:create.
api.use(keyTicketsRouter);
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

// -------- work filters + agent helpers --------------------------------------
// /feed-path → ./api/agent-helpers.ts (#B.213 phase 1.C). Moderation rules are
// automation rules (`message_posted` + `decision`) since #2697.
// #457 — the unified automation engine's CRUD, under `/automation/*`. It is
// the only rule surface left: the legacy `/rules` (#2697) and `/work-filters`
// (#2718) wrote tables the engine had stopped reading.
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
api.use(signalsRouter);
api.use(signalKeysRouter);
api.use(ticketSubscriptionsRouter);
