/**
 * Config home (#235, david h629b3 "réorient la maison config"). One read
 * endpoint for the frontend's boot-time configuration, replacing the
 * one-micro-router-per-config-slice drift (formerly `GET /formatting` on
 * its own router — see #cpd7zw on the API-proliferation concern). The
 * frontend fetches THIS once at boot instead of N separate config calls.
 *
 * Read-only aggregate. Mutations stay on their targeted PATCH endpoints
 * (`PATCH /strategy`, `PATCH /settings/upload-max-bytes`) — config writes
 * are rare and per-key, no need to generalize them here yet. As more
 * config slices need frontend exposure (prompts, etc.) they fold into the
 * payload below rather than each spawning its own router.
 *
 * Cheap: re-reads the yaml chain per request (files <10KB total) plus two
 * settings getters. The frontend hits it once at boot, so no cache layer.
 */
import { Router } from "express";
import { findConfigUpwards, globalConfigPath, loadConfig } from "../autopoll/config.js";
import { defaultPingsPath } from "../claude-loop/state.js";
import { getStrategy, getUploadMaxBytes } from "../db.js";
import { resolveFormatting } from "../formatting.js";

export const configRouter = Router();

configRouter.get("/config", (_req, res) => {
    // #160 Phase 1 — expose les upstream bindings (Record<project, bindings[]>)
    // pour que le frontend résolve `gh#NNN` localement au rendering. Layered
    // comme le reste de la config (defaults → global → daemon cwd).
    const cfg = loadConfig(process.cwd());
    res.json({
        formatting: resolveFormatting({
            shippedDefaultsPath: defaultPingsPath(),
            globalConfigPath: globalConfigPath(),
            projectConfigPath: findConfigUpwards(process.cwd()),
        }),
        strategy: getStrategy(),
        uploadMaxBytes: getUploadMaxBytes(),
        upstream: cfg.upstream,
    });
});
