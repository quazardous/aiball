/**
 * #447 — per-agent work-filter CRUD routes. A work filter narrows which tickets
 * a consumer (agent) picks up, by tag (applied server-side in the actionable/
 * claimable gate). Mirrors the moderation-rules router shape (list / create /
 * delete / toggle-enabled). Stored in the daemon DB so every loop hitting this
 * daemon — on any machine — shares the same filter.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteWorkFilter,
    insertWorkFilter,
    listWorkFilters,
    setWorkFilterEnabled,
} from "../db.js";
import { badRequest, notFound } from "./_helpers.js";

export const workFiltersRouter = Router();

workFiltersRouter.get("/work-filters", (req, res) => {
    const consumerId = typeof req.query.consumer_id === "string" ? req.query.consumer_id : undefined;
    res.json(listWorkFilters({ consumerId }));
});

workFiltersRouter.post("/work-filters", (req: Request, res: Response) => {
    const { consumer_id, project, mode, match_tags, position, note } = req.body ?? {};
    if (typeof consumer_id !== "string" || consumer_id.trim() === "") {
        return badRequest(res, "consumer_id is required");
    }
    if (mode !== undefined && mode !== "only" && mode !== "except") {
        return badRequest(res, "mode must be 'only' or 'except'");
    }
    if (match_tags !== undefined && (!Array.isArray(match_tags) || match_tags.some((t) => typeof t !== "string"))) {
        return badRequest(res, "match_tags must be an array of tag names");
    }
    const tags = (match_tags as string[] | undefined)?.map((t) => t.trim()).filter(Boolean) ?? [];
    if (tags.length === 0) {
        return badRequest(res, "match_tags must list at least one tag");
    }
    const f = insertWorkFilter({
        consumer_id: consumer_id.trim(),
        project: typeof project === "string" && project.trim() !== "" ? project.trim() : null,
        mode: mode === "except" ? "except" : "only",
        match_tags: tags,
        position: typeof position === "number" ? position : 0,
        note: typeof note === "string" ? note : null,
    });
    res.status(201).json(f);
});

workFiltersRouter.delete("/work-filters/:id", (req, res) => {
    deleteWorkFilter(Number(req.params.id));
    res.status(204).end();
});

workFiltersRouter.patch("/work-filters/:id", (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
        return badRequest(res, "only `enabled: boolean` supported for now");
    }
    const f = setWorkFilterEnabled(Number(req.params.id), enabled);
    if (!f) return notFound(res);
    res.json(f);
});
