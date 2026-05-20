/**
 * Moderation rule CRUD routes (#B.213 phase 1.C).
 * Carved out of api.ts on 2026-05-19 — behavior-preserving move.
 * `position` & `enabled` flips happen here; the engine itself lives
 * in src/messages.ts.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteRule,
    insertRule,
    listRules,
    setRuleEnabled,
} from "../db.js";
import { VALID_KINDS } from "../messages.js";
import { broadcast } from "../ws.js";
import { badRequest, notFound } from "./_helpers.js";

export const rulesRouter = Router();

rulesRouter.get("/rules", (_req, res) => {
    res.json(listRules());
});

rulesRouter.post("/rules", (req: Request, res: Response) => {
    const { decision, match_project, match_kind, match_by_agent, position, note } =
        req.body ?? {};
    if (decision !== "auto" && decision !== "review") {
        return badRequest(res, "decision must be 'auto' or 'review'");
    }
    if (match_kind && !VALID_KINDS.includes(match_kind)) {
        return badRequest(res, `match_kind must be one of ${VALID_KINDS.join(", ")}`);
    }
    const r = insertRule({
        decision,
        match_project: match_project ?? null,
        match_kind: match_kind ?? null,
        match_by_agent: match_by_agent ?? null,
        position: typeof position === "number" ? position : 0,
        note: note ?? null,
    });
    broadcast({ type: "rule_changed", data: r });
    res.status(201).json(r);
});

rulesRouter.delete("/rules/:id", (req, res) => {
    deleteRule(Number(req.params.id));
    broadcast({ type: "rule_changed", data: { id: Number(req.params.id), deleted: true } });
    res.status(204).end();
});

rulesRouter.patch("/rules/:id", (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
        return badRequest(res, "only `enabled: boolean` supported for now");
    }
    const r = setRuleEnabled(Number(req.params.id), enabled);
    if (!r) return notFound(res);
    broadcast({ type: "rule_changed", data: r });
    res.json(r);
});
