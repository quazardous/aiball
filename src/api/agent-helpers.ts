/**
 * Misc agent-facing helper routes (#B.213 phase 1.C).
 * Today just `/feed-path` for `aiball feed-path <project>` (CLI tail
 * helper). Carved out of api.ts on 2026-05-19 — behavior-preserving
 * move.
 */
import { serveMethod } from "../bus/http.js";
import { Router } from "express";

export const agentHelpersRouter = Router();

agentHelpersRouter.get("/feed-path", serveMethod("project.feed_path"));
