/**
 * Misc agent-facing helper routes (#B.213 phase 1.C).
 * Today just `/feed-path` for `aiball feed-path <project>` (CLI tail
 * helper). Carved out of api.ts on 2026-05-19 — behavior-preserving
 * move.
 */
import { Router } from "express";
import { outboxPath } from "../paths.js";
import { badRequest } from "./_helpers.js";

export const agentHelpersRouter = Router();

agentHelpersRouter.get("/feed-path", (req, res) => {
    const project = req.query.project as string | undefined;
    if (!project) return badRequest(res, "project query required");
    try {
        res.json({ path: outboxPath(project) });
    } catch (e) {
        return badRequest(res, (e as Error).message);
    }
});
