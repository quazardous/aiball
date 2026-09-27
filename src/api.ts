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













// -------- messages -------------------------------------------------------
// All /messages routes (CRUD + moderation + decision-on-comment + #B.104
// question audit + #B.130 summarize + note) → ./api/messages.ts
// (#B.213 phase 1.F).
api.use(messagesRouter);

// -------- tickets (derived view) -------------------------------------------

api.get("/projects", serveMethod("project.list"));








/**
 * #475 david : "danger zone globale pour purger les tickets fermés depuis
 * + 1 an". Same purge semantics as `/projects/:name/purge` but applied
 * to EVERY known project. Implementation walks `listProjects()` + calls
 * the per-project purge in sequence — keeps the cascade logic in one
 * place + emits the existing `project_purged` event per touched project
 * so other open tabs refresh counters incrementally as it sweeps.
 */








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
