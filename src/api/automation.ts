/**
 * #457 slice 4 — CRUD for the unified `automation_rules` table. The rules are
 * bus methods (`src/bus/methods/automation.ts`); these routes serve them.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const automationRouter = Router();

automationRouter.get("/automation/rules", serveMethod("automation.rules"));
automationRouter.post("/automation/rules", serveMethod("automation.create_rule", undefined, { status: 201 }));
automationRouter.delete("/automation/rules/:id", serveMethod("automation.delete_rule", undefined, { status: 204, respond: (res) => { res.end(); } }));
automationRouter.patch("/automation/rules/:id", serveMethod("automation.update_rule"));
