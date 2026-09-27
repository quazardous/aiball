/**
 * #449 — unified config manager REST surface, served by the bus methods
 * `config.managed` / `config.set` / `config.clear` (src/bus/methods/board.ts).
 * Reads the schema-resolved config (global + optional project layer) and
 * writes/clears overrides. The schema
 * itself is in code (src/config/schema.ts); this only manages OVERRIDES.
 *
 * Distinct from the existing `GET /api/config` (boot-time aggregate) — this is
 * the generic, schema-driven manager. `protected` keys are write-gated to a
 * human/moderator.
 *
 *   GET    /managed-config[?project=X]      → resolved rows (schema + layers + effective)
 *   PUT    /managed-config/:key             → set override { value, project? }
 *   DELETE /managed-config/:key[?project=X]  → clear an override (revert to layer below)
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const managedConfigRouter = Router();

managedConfigRouter.get("/managed-config", serveMethod("config.managed"));
managedConfigRouter.put("/managed-config/:key", serveMethod("config.set"));
managedConfigRouter.delete("/managed-config/:key", serveMethod("config.clear", undefined, { status: 204, respond: (res) => { res.end(); } }));
