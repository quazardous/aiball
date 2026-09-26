/**
 * #3067 — the automation rules on the bus (#457): list, create, update,
 * delete. A rule is `triggers` (a union), `match_*` conditions or an
 * `expression` tree, and a stack of typed `actions` (`assign` / `decision` /
 * `pickup` / `add_tag` / `set_priority` / `notify`). The rules of the YAML
 * config come after the database's, with negative ids, and are read-only.
 */
import { z } from "zod";
import { defineMethod, Refusal } from "../methods.js";
import { flag } from "../params.js";
import {
    deleteAutomationRule,
    insertAutomationRule,
    listAutomationRules,
    updateAutomationRule,
    validateConditionTree,
    type AutomationAction,
    type AutomationRule,
    type ConditionTree,
    type NewAutomationRule,
    type Trigger,
} from "../../db/automation.js";
import { loadYamlAutomationRules } from "../../automation/yaml.js";
import { broadcast } from "../../ws.js";

const VALID_TRIGGERS: readonly Trigger[] = [
    "message_posted",
    "actionable_eval",
    "ticket_created",
    "ticket_tagged",
];

const YAML_READ_ONLY = "YAML automation rules are read-only — edit the .aiball.yaml file";

/** Validate + normalize one action into a typed `AutomationAction`. */
function parseAction(raw: unknown): AutomationAction {
    if (!raw || typeof raw !== "object") throw new Refusal(400, "action object is required");
    const a = raw as Record<string, unknown>;
    switch (a.kind) {
        case "assign": {
            const cid = typeof a.consumer_id === "string" ? a.consumer_id.trim() : "";
            if (!cid) throw new Refusal(400, "action.consumer_id is required for kind=assign");
            return { kind: "assign", consumer_id: cid };
        }
        case "decision": {
            const d = a.decision;
            if (d !== "auto" && d !== "review") throw new Refusal(400, "action.decision must be 'auto' or 'review'");
            return { kind: "decision", decision: d };
        }
        case "pickup": {
            const m = a.mode;
            if (m !== "only" && m !== "except") throw new Refusal(400, "action.mode must be 'only' or 'except'");
            return { kind: "pickup", mode: m };
        }
        case "add_tag": {
            const tag = typeof a.tag === "string" ? a.tag.trim() : "";
            if (!tag) throw new Refusal(400, "action.tag is required for kind=add_tag");
            return { kind: "add_tag", tag };
        }
        case "set_priority": {
            const p = a.priority;
            if (p !== "urgent" && p !== "high" && p !== "normal" && p !== "low") {
                throw new Refusal(400, "action.priority must be urgent|high|normal|low");
            }
            return { kind: "set_priority", priority: p };
        }
        case "notify": {
            const cid = typeof a.consumer_id === "string" ? a.consumer_id.trim() : "";
            if (!cid) throw new Refusal(400, "action.consumer_id is required for kind=notify");
            return { kind: "notify", consumer_id: cid };
        }
        default:
            throw new Refusal(400, "action.kind must be one of assign|decision|pickup|add_tag|set_priority|notify");
    }
}

/** A single trigger or a list; at least one, each known. */
function parseTriggers(raw: unknown): Trigger[] {
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    if (list.length === 0) throw new Refusal(400, "triggers must list at least one event");
    for (const t of list) {
        if (typeof t !== "string" || !(VALID_TRIGGERS as readonly string[]).includes(t)) {
            throw new Refusal(400, `unknown trigger '${t}'`);
        }
    }
    return list as Trigger[];
}

/** #457 slice 5.5 — the canonical stack; an empty one is a no-op nobody asked for. */
function parseActions(raw: unknown): AutomationAction[] {
    if (!Array.isArray(raw)) throw new Refusal(400, "actions must be an array");
    if (raw.length === 0) throw new Refusal(400, "actions must contain at least one entry");
    return raw.map((a, i) => {
        try {
            return parseAction(a);
        } catch (e) {
            throw e instanceof Refusal ? new Refusal(400, `actions[${i}] : ${e.message}`) : e;
        }
    });
}

function parseMatchTags(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
        throw new Refusal(400, "match_tags must be an array of tag names");
    }
    return (raw as string[]).map((t) => t.trim()).filter(Boolean);
}

function writable(id: number): void {
    if (id < 0) throw new Refusal(400, YAML_READ_ONLY);
}

const ruleId = z.coerce.number().int();
const loose = z.unknown().optional();

/** The rules, database first (the UI's, which may override), then the YAML's. */
defineMethod({
    name: "automation.rules",
    who: ["human", "agent"],
    params: z.object({ trigger: z.string().optional(), scope_consumer: z.string().optional(), enabled_only: flag }),
    run: (_caller, p) => {
        const trigger = p.trigger ? (p.trigger as Trigger) : undefined;
        if (trigger && !VALID_TRIGGERS.includes(trigger)) {
            throw new Refusal(400, `trigger must be one of ${VALID_TRIGGERS.join(", ")}`);
        }
        const scopeConsumer = p.scope_consumer || undefined;
        const enabledOnly = p.enabled_only === true;
        const db = listAutomationRules({
            ...(trigger ? { trigger } : {}),
            ...(scopeConsumer ? { scopeConsumer } : {}),
            ...(enabledOnly ? { enabledOnly } : {}),
        });
        const yaml = loadYamlAutomationRules().filter((r: AutomationRule) => {
            if (enabledOnly && !r.enabled) return false;
            if (trigger && !r.triggers.includes(trigger)) return false;
            if (scopeConsumer !== undefined && r.scope_consumer !== null && r.scope_consumer !== scopeConsumer) return false;
            return true;
        });
        return [...db, ...yaml];
    },
});

/**
 * Create a rule. `actions` is the canonical stack; without it the single
 * `action` is required. `expression` (#457 slice 5.2), when set, replaces the
 * AND of the flat `match_*` fields; a malformed tree is refused here so it
 * never reaches the engine.
 */
defineMethod({
    name: "automation.create_rule",
    who: ["human", "agent"],
    params: z.object({
        triggers: loose, scope_consumer: loose, match_project: loose, match_kind: loose, match_by_agent: loose,
        match_tags: loose, match_tag_added: loose, match_intent: loose, match_priority: loose,
        action: loose, actions: loose, expression: loose, position: loose, note: loose,
    }),
    run: (_caller, p) => {
        const triggers = parseTriggers(p.triggers);
        const matchTags = p.match_tags !== undefined && p.match_tags !== null ? parseMatchTags(p.match_tags) : [];
        const actions = p.actions !== undefined && p.actions !== null ? parseActions(p.actions) : undefined;
        const action = actions ? undefined : parseAction(p.action);
        let expression: ConditionTree | undefined;
        if (p.expression !== undefined && p.expression !== null) {
            const v = validateConditionTree(p.expression);
            if (!v) {
                throw new Refusal(400, "expression : malformed condition tree (expected kind ∈ and|or|not|leaf, recursive, leaves carry field+op+value)");
            }
            expression = v;
        }
        const trimmed = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
        const plain = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
        const r = insertAutomationRule({
            triggers,
            scope_consumer: trimmed(p.scope_consumer),
            match_project: trimmed(p.match_project),
            match_kind: plain(p.match_kind),
            match_by_agent: plain(p.match_by_agent),
            match_tags: matchTags,
            match_tag_added: plain(p.match_tag_added),
            match_intent: plain(p.match_intent),
            match_priority: plain(p.match_priority),
            ...(actions ? { actions } : { action: action! }),
            ...(expression ? { expression } : {}),
            position: typeof p.position === "number" ? p.position : 0,
            note: typeof p.note === "string" ? p.note : null,
        });
        broadcast({ type: "automation_rule_changed", data: r });
        return r;
    },
});

/** Change any part of a rule; only what is present changes, checked as on create. */
defineMethod({
    name: "automation.update_rule",
    who: ["human", "agent"],
    params: z.object({
        id: ruleId,
        enabled: loose, triggers: loose, expression: loose, actions: loose, action: loose,
        scope_consumer: loose, match_project: loose, match_kind: loose, match_by_agent: loose,
        match_tags: loose, match_tag_added: loose, match_intent: loose, match_priority: loose,
        note: loose, position: loose,
    }),
    run: (_caller, p) => {
        writable(p.id);
        const body = p as Record<string, unknown>;
        const patch: Partial<NewAutomationRule> & { enabled?: boolean } = {};
        if (p.enabled !== undefined) {
            if (typeof p.enabled !== "boolean") throw new Refusal(400, "enabled must be a boolean");
            patch.enabled = p.enabled;
        }
        if (p.triggers !== undefined) patch.triggers = parseTriggers(p.triggers);
        if (p.expression !== undefined && p.expression !== null) {
            const v = validateConditionTree(p.expression);
            if (!v) throw new Refusal(400, "expression : malformed condition tree");
            patch.expression = v;
        }
        if (p.actions !== undefined && p.actions !== null) patch.actions = parseActions(p.actions);
        else if (p.action !== undefined && p.action !== null) patch.action = parseAction(p.action);

        // Flat match_* fields: a string is trimmed, empty means null; any other type is ignored.
        const strOrNull = (k: string): string | null | undefined => {
            if (!(k in body) || body[k] === undefined) return undefined;
            const v = body[k];
            if (v === null) return null;
            if (typeof v === "string") return v.trim() === "" ? null : v.trim();
            return undefined;
        };
        for (const k of ["match_project", "match_kind", "match_by_agent", "match_tag_added", "match_intent", "match_priority", "scope_consumer"] as const) {
            const v = strOrNull(k);
            if (v !== undefined) patch[k] = v;
        }
        if (p.match_tags !== undefined) patch.match_tags = parseMatchTags(p.match_tags);
        if (p.note !== undefined) {
            if (p.note !== null && typeof p.note !== "string") throw new Refusal(400, "note must be a string or null");
            patch.note = (p.note as string | null) ?? null;
        }
        if (p.position !== undefined) {
            if (typeof p.position !== "number" || !Number.isFinite(p.position)) throw new Refusal(400, "position must be a number");
            patch.position = p.position;
        }
        let r: AutomationRule | null;
        try {
            r = updateAutomationRule(p.id, patch);
        } catch (e) {
            throw new Refusal(400, (e as Error).message);
        }
        if (!r) throw new Refusal(404, "not found");
        broadcast({ type: "automation_rule_changed", data: r });
        return r;
    },
});

/** Delete a rule of the database; a YAML rule lives in its file and is refused. */
defineMethod({
    name: "automation.delete_rule",
    who: ["human", "agent"],
    params: z.object({ id: ruleId }),
    run: (_caller, p) => {
        writable(p.id);
        deleteAutomationRule(p.id);
        broadcast({ type: "automation_rule_changed", data: { id: p.id, deleted: true } });
        return { id: p.id, deleted: true };
    },
});
