import { Router } from "express";
import { bearerAuth } from "./auth.js";
import { schedulerStatus } from "./cron/index.js";
import { AIBALL_VERSION } from "./version.js";
import { authRouter } from "./api/auth.js";
import { consumersRouter } from "./api/consumers.js";
import { signalsRouter } from "./api/signals.js";
import { keyTicketsRouter } from "./api/key-tickets.js";
import { uploadsRouter } from "./api/uploads.js";

/**
 * The HTTP API production keeps (#3068): the bus carries every method; what
 * stays on HTTP is what a bus client cannot do or is not — logging in and the
 * install probe, uploads, the signal and key-ticket doors of API keys, the
 * few consumer routes a loop or a script still reaches, and the health probe.
 * `docs/API-ROUTES.md` lists them with their consumers.
 */
export const api = Router();

// Mounted first so every route below gets `req.consumer_id` from the bearer
// token. PUBLIC_PATHS bypass it: /api/health, /api/auth/{setup,login,status}.
// Everything else needs a valid auth or agent token.
api.use(bearerAuth);

// /api/auth/* — login, setup, status, the install probe.
api.use(authRouter);

// Uploads; the upload cap is a bus method (upload.max_bytes).
api.use(uploadsRouter);

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

// #2526 — POST /api/tickets, for an API key with the scope tickets:create.
api.use(keyTicketsRouter);
api.use(consumersRouter);
// POST /api/signals — an external system's signal, with a signal key.
api.use(signalsRouter);
