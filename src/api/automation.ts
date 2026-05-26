/**
 * #457 slice 4 — CRUD for the unified `automation_rules` table.
 *
 * Mirrors the legacy `rules.ts` / `work-filters.ts` router shape (list /
 * create / delete / toggle-enabled), but speaks the unified rule vocabulary :
 * `triggers` (union array), `match_*` conditions, and a typed `action`
 * discriminated union (`assign` / `decision` / `pickup` / `add_tag` /
 * `set_priority` / `notify`).
 *
 * The legacy `rules` + `work_filters` tables stay live on their own engines
 * until slice 3 (YAML) and a follow-up migration move them onto this engine.
 */
import { Router, type Request, type Response } from "express";
import {
    deleteAutomationRule,
    insertAutomationRule,
    listAutomationRules,
    setAutomationRuleEnabled,
    validateConditionTree,
    type AutomationAction,
    type AutomationRule,
    type ConditionTree,
    type Trigger,
} from "../db/automation.js";
import { loadYamlAutomationRules } from "../automation/yaml.js";
import { broadcast } from "../ws.js";
import { badRequest, notFound } from "./_helpers.js";

export const automationRouter = Router();

const VALID_TRIGGERS: readonly Trigger[] = [
    "message_posted",
    "actionable_eval",
    "ticket_created",
    "ticket_tagged",
];

/** Validate + normalize the request body into a typed `AutomationAction`. */
function parseAction(raw: unknown): AutomationAction | { error: string } {
    if (!raw || typeof raw !== "object") {
        return { error: "action object is required" };
    }
    const a = raw as Record<string, unknown>;
    switch (a.kind) {
        case "assign": {
            const cid = typeof a.consumer_id === "string" ? a.consumer_id.trim() : "";
            if (!cid) return { error: "action.consumer_id is required for kind=assign" };
            return { kind: "assign", consumer_id: cid };
        }
        case "decision": {
            const d = a.decision;
            if (d !== "auto" && d !== "review") {
                return { error: "action.decision must be 'auto' or 'review'" };
            }
            return { kind: "decision", decision: d };
        }
        case "pickup": {
            const m = a.mode;
            if (m !== "only" && m !== "except") {
                return { error: "action.mode must be 'only' or 'except'" };
            }
            return { kind: "pickup", mode: m };
        }
        case "add_tag": {
            const tag = typeof a.tag === "string" ? a.tag.trim() : "";
            if (!tag) return { error: "action.tag is required for kind=add_tag" };
            return { kind: "add_tag", tag };
        }
        case "set_priority": {
            const p = a.priority;
            if (p !== "urgent" && p !== "high" && p !== "normal" && p !== "low") {
                return { error: "action.priority must be urgent|high|normal|low" };
            }
            return { kind: "set_priority", priority: p };
        }
        case "notify": {
            const cid = typeof a.consumer_id === "string" ? a.consumer_id.trim() : "";
            if (!cid) return { error: "action.consumer_id is required for kind=notify" };
            return { kind: "notify", consumer_id: cid };
        }
        default:
            return { error: `action.kind must be one of assign|decision|pickup|add_tag|set_priority|notify` };
    }
}

automationRouter.get("/automation/rules", (req, res) => {
    const trigger = typeof req.query.trigger === "string" ? (req.query.trigger as Trigger) : undefined;
    if (trigger && !VALID_TRIGGERS.includes(trigger)) {
        return badRequest(res, `trigger must be one of ${VALID_TRIGGERS.join(", ")}`);
    }
    const scopeConsumer =
        typeof req.query.scope_consumer === "string" && req.query.scope_consumer
            ? req.query.scope_consumer
            : undefined;
    const enabledOnly = req.query.enabled_only === "1" || req.query.enabled_only === "true";

    // DB rules first (UI-controlled, can override), YAML rules second
    // (slice 3 — versioned defaults). UI badges YAML rows by `id < 0`.
    const db = listAutomationRules({
        ...(trigger ? { trigger } : {}),
        ...(scopeConsumer ? { scopeConsumer } : {}),
        ...(enabledOnly ? { enabledOnly } : {}),
    });
    const yaml = loadYamlAutomationRules().filter((r: AutomationRule) => {
        if (enabledOnly && !r.enabled) return false;
        if (trigger && !r.triggers.includes(trigger)) return false;
        if (scopeConsumer !== undefined && r.scope_consumer !== null && r.scope_consumer !== scopeConsumer) {
            return false;
        }
        return true;
    });
    res.json([...db, ...yaml]);
});

automationRouter.post("/automation/rules", (req: Request, res: Response) => {
    const {
        triggers,
        scope_consumer,
        match_project,
        match_kind,
        match_by_agent,
        match_tags,
        match_tag_added,
        match_intent,
        match_priority,
        action,
        actions,
        expression,
        position,
        note,
    } = req.body ?? {};

    // triggers : accept single string or array. At least one valid trigger required.
    const list = Array.isArray(triggers) ? triggers : triggers != null ? [triggers] : [];
    if (list.length === 0) {
        return badRequest(res, "triggers must list at least one event");
    }
    for (const t of list) {
        if (typeof t !== "string" || !(VALID_TRIGGERS as readonly string[]).includes(t)) {
            return badRequest(res, `unknown trigger '${t}'`);
        }
    }
    if (match_tags !== undefined && match_tags !== null) {
        if (!Array.isArray(match_tags) || match_tags.some((t) => typeof t !== "string")) {
            return badRequest(res, "match_tags must be an array of tag names");
        }
    }

    // #457 slice 5.5 : `actions: AutomationAction[]` is the canonical stack
    // (david `aa48pd`). When provided, validate each entry through the same
    // `parseAction` we use for the legacy single `action`. Empty array is
    // a 400 — a rule with zero actions is a no-op nobody asked for.
    let parsedActions: AutomationAction[] | undefined;
    if (actions !== undefined && actions !== null) {
        if (!Array.isArray(actions)) {
            return badRequest(res, "actions must be an array");
        }
        if (actions.length === 0) {
            return badRequest(res, "actions must contain at least one entry");
        }
        const out: AutomationAction[] = [];
        for (let i = 0; i < actions.length; i++) {
            const v = parseAction(actions[i]);
            if ("error" in v) {
                return badRequest(res, `actions[${i}] : ${v.error}`);
            }
            out.push(v);
        }
        parsedActions = out;
    }
    // Back-compat : if no `actions` field, the legacy `action` is required.
    // When BOTH are present, `actions` wins (canonical surface).
    let firstAction: AutomationAction | undefined;
    if (!parsedActions) {
        const act = parseAction(action);
        if ("error" in act) return badRequest(res, act.error);
        firstAction = act;
    }

    // #457 slice 5.2 : optional `expression` condition tree (overrides the
    // synthesized AND-of-leaves from the flat `match_*` fields when set).
    // Strict shape-check rejects malformed trees up front, so an invalid
    // payload can't land in the DB and crash the engine downstream.
    let parsedExpression: ConditionTree | undefined;
    if (expression !== undefined && expression !== null) {
        const v = validateConditionTree(expression);
        if (!v) {
            return badRequest(
                res,
                "expression : malformed condition tree (expected kind ∈ and|or|not|leaf, recursive, leaves carry field+op+value)",
            );
        }
        parsedExpression = v;
    }

    const r = insertAutomationRule({
        triggers: list as Trigger[],
        scope_consumer:
            typeof scope_consumer === "string" && scope_consumer.trim() !== ""
                ? scope_consumer.trim()
                : null,
        match_project:
            typeof match_project === "string" && match_project.trim() !== ""
                ? match_project.trim()
                : null,
        match_kind: typeof match_kind === "string" && match_kind !== "" ? match_kind : null,
        match_by_agent:
            typeof match_by_agent === "string" && match_by_agent !== "" ? match_by_agent : null,
        match_tags: Array.isArray(match_tags)
            ? (match_tags as string[]).map((t) => t.trim()).filter(Boolean)
            : [],
        match_tag_added:
            typeof match_tag_added === "string" && match_tag_added !== "" ? match_tag_added : null,
        match_intent: typeof match_intent === "string" && match_intent !== "" ? match_intent : null,
        match_priority:
            typeof match_priority === "string" && match_priority !== "" ? match_priority : null,
        // Slice 5.5 — pass `actions` when set, else fall back to single `action`.
        // insertAutomationRule reconciles either input into the canonical array.
        ...(parsedActions ? { actions: parsedActions } : { action: firstAction! }),
        ...(parsedExpression ? { expression: parsedExpression } : {}),
        position: typeof position === "number" ? position : 0,
        note: typeof note === "string" ? note : null,
    });
    broadcast({ type: "automation_rule_changed", data: r });
    res.status(201).json(r);
});

automationRouter.delete("/automation/rules/:id", (req, res) => {
    const id = Number(req.params.id);
    // #457 slice 3 : YAML rules carry synthetic negative ids — they live in
    // the file, not the DB. Refuse instead of silently no-op'ing on a
    // missing row, so the UI gets an unambiguous error.
    if (id < 0) {
        return badRequest(res, "YAML automation rules are read-only — edit the .aiball.yaml file");
    }
    deleteAutomationRule(id);
    broadcast({ type: "automation_rule_changed", data: { id, deleted: true } });
    res.status(204).end();
});

automationRouter.patch("/automation/rules/:id", (req, res) => {
    const id = Number(req.params.id);
    if (id < 0) {
        return badRequest(res, "YAML automation rules are read-only — edit the .aiball.yaml file");
    }
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
        return badRequest(res, "only `enabled: boolean` supported for now");
    }
    const r = setAutomationRuleEnabled(id, enabled);
    if (!r) return notFound(res);
    broadcast({ type: "automation_rule_changed", data: r });
    res.json(r);
});
