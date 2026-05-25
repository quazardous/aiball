/**
 * #449 — unified config manager REST surface. Reads the schema-resolved config
 * (global + optional project layer) and writes/clears overrides. The schema
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
import { Router, type Request, type Response } from "express";
import {
    deleteConfigOverride,
    getResolvedConfig,
    isHuman,
    setConfigOverride,
} from "../db.js";
import {
    allowsGlobalOverride,
    allowsProjectOverride,
    coerceConfigValue,
    getSchemaEntry,
} from "../config/schema.js";
import { badRequest, notFound } from "./_helpers.js";
import { consumerOf } from "./_helpers.js";

export const managedConfigRouter = Router();

managedConfigRouter.get("/managed-config", (req: Request, res: Response) => {
    const project = typeof req.query.project === "string" && req.query.project.trim() !== ""
        ? req.query.project.trim()
        : null;
    res.json({ project, config: getResolvedConfig(project) });
});

managedConfigRouter.put("/managed-config/:key", (req: Request, res: Response) => {
    const key = String(req.params.key ?? "");
    const entry = getSchemaEntry(key);
    if (!entry) return notFound(res, `unknown config key '${key}'`);

    const body = (req.body ?? {}) as { value?: unknown; project?: unknown };
    const project = typeof body.project === "string" && body.project.trim() !== ""
        ? body.project.trim()
        : ""; // '' = global layer

    // Layer must be allowed by the key's scope.
    if (project === "" && !allowsGlobalOverride(entry)) {
        return badRequest(res, `key '${key}' has no global value (scope=${entry.scope}) — set it per project`);
    }
    if (project !== "" && !allowsProjectOverride(entry)) {
        return badRequest(res, `key '${key}' is not project-overridable (scope=${entry.scope})`);
    }

    // Protected keys: write reserved to a human/moderator.
    if (entry.protected && !isHuman(consumerOf(req))) {
        return res.status(403).json({ error: `config key '${key}' is protected (moderator-only)` });
    }

    const value = coerceConfigValue(entry, body.value);
    if (value === null) {
        return badRequest(res, `invalid value for '${key}' (type ${entry.type}${entry.options ? `, one of ${entry.options.join("|")}` : ""})`);
    }

    setConfigOverride(project, key, value, consumerOf(req));
    res.json({ key, project: project || null, value });
});

managedConfigRouter.delete("/managed-config/:key", (req: Request, res: Response) => {
    const key = String(req.params.key ?? "");
    const entry = getSchemaEntry(key);
    if (!entry) return notFound(res, `unknown config key '${key}'`);
    const project = typeof req.query.project === "string" && req.query.project.trim() !== ""
        ? req.query.project.trim()
        : "";
    if (entry.protected && !isHuman(consumerOf(req))) {
        return res.status(403).json({ error: `config key '${key}' is protected (moderator-only)` });
    }
    deleteConfigOverride(project, key);
    res.status(204).end();
});
