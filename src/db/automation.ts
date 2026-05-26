/**
 * #457 — unified automation engine, DB layer (CRUD + typed shapes).
 *
 * The schema is intentionally **discriminated-union over `action_kind`** and
 * **open-vocabulary over `trigger`** : new triggers and new actions plug in
 * without touching the table. The pure matcher lives in
 * `src/automation/engine.ts` (no DB dependency, fully unit-testable).
 *
 * Triggers (slice 1 declares the shape ; the lifecycle hookups land in
 * slice 2/3 — the engine itself is a no-op as long as no caller fires it) :
 *   - `message_posted`    legacy moderation (rules → automation_rules, slice 3)
 *   - `actionable_eval`   legacy pickup gate (work_filters → automation_rules, slice 3)
 *   - `ticket_created`    NEW — fires when a ticket lands (post-moderation)
 *   - `ticket_tagged`     NEW — fires when a tag is added (or removed) to a ticket
 *
 * Actions :
 *   - `decision`         → `{ decision: 'auto' | 'review' }`     (moderation)
 *   - `pickup`           → `{ mode: 'only' | 'except' }`         (pickup gate)
 *   - `assign`           → `{ consumer_id: string }`             (NEW — david's scenarios)
 *   - `add_tag`          → `{ tag: string }`                     (extensible)
 *   - `set_priority`     → `{ priority: 'urgent'|'high'|'normal'|'low' }`  (extensible)
 *   - `notify`           → `{ consumer_id: string }`             (extensible)
 *
 * CRUD mirrors db/rules.ts + db/work-filters.ts. The fail-open accessor
 * (`getEnabledRulesForTrigger`) degrades to `[]` on read error so a fresh
 * tsx-hot-reload that hasn't applied migration 0039 doesn't break callers.
 */
import { and, asc, eq, like } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

// ---------------------------------------------------------------------------
// Trigger vocabulary (open — extensible).
// ---------------------------------------------------------------------------

export type Trigger =
    | "message_posted"
    | "actionable_eval"
    | "ticket_created"
    | "ticket_tagged";

// ---------------------------------------------------------------------------
// Action discriminated union (extensible — add a new case + a new schema).
// ---------------------------------------------------------------------------

export type AutomationAction =
    | { kind: "decision"; decision: "auto" | "review" }
    | { kind: "pickup"; mode: "only" | "except" }
    | { kind: "assign"; consumer_id: string }
    | { kind: "add_tag"; tag: string }
    | { kind: "set_priority"; priority: "urgent" | "high" | "normal" | "low" }
    | { kind: "notify"; consumer_id: string };

export type ActionKind = AutomationAction["kind"];

// ---------------------------------------------------------------------------
// #457 slice 5.1 — compositional condition tree.
// ---------------------------------------------------------------------------

/** Fields a leaf can address. Maps 1:1 onto the legacy `match_*` columns +
 *  the AutomationEvent payload fields (see automation/engine.ts). */
export type ConditionField =
    | "project"
    | "kind"
    | "by_agent"
    | "intent"
    | "priority"
    | "tag_added"
    | "tags"
    | "scope_consumer";

/** Leaf comparison operators :
 *  - `eq` / `neq` : strict (in)equality, value is a string/null.
 *  - `in`         : value is a string[] — leaf matches if event[field] ∈ value.
 *  - `includes`   : event[field] is itself a string[] (e.g. ticket tags) —
 *                   leaf matches if value (a string) is a member of it. */
export type ConditionOp = "eq" | "neq" | "in" | "includes";

export type ConditionTree =
    | { kind: "and"; children: ConditionTree[] }
    | { kind: "or"; children: ConditionTree[] }
    | { kind: "not"; child: ConditionTree }
    | { kind: "leaf"; field: ConditionField; op: ConditionOp; value: unknown };

const VALID_FIELDS: ConditionField[] = [
    "project", "kind", "by_agent", "intent", "priority",
    "tag_added", "tags", "scope_consumer",
];
const VALID_OPS: ConditionOp[] = ["eq", "neq", "in", "includes"];

/** Recursively shape-check a parsed JSON value into a ConditionTree, or
 *  null on any structural mismatch. Used by `decodeExpression` ; reusable
 *  by the API validator without going through JSON.parse twice. */
export function validateConditionTree(raw: unknown): ConditionTree | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    switch (o.kind) {
        case "and":
        case "or": {
            if (!Array.isArray(o.children)) return null;
            const children: ConditionTree[] = [];
            for (const c of o.children) {
                const v = validateConditionTree(c);
                if (!v) return null;
                children.push(v);
            }
            return { kind: o.kind, children };
        }
        case "not": {
            const v = validateConditionTree(o.child);
            return v ? { kind: "not", child: v } : null;
        }
        case "leaf": {
            const field = o.field;
            const op = o.op;
            if (typeof field !== "string" || !(VALID_FIELDS as string[]).includes(field)) return null;
            if (typeof op !== "string" || !(VALID_OPS as string[]).includes(op)) return null;
            return {
                kind: "leaf",
                field: field as ConditionField,
                op: op as ConditionOp,
                value: o.value,
            };
        }
        default:
            return null;
    }
}

/** Decode the `expression` column. NULL / malformed → null ; the caller
 *  (rowToRule) then synthesizes a legacy-flat tree for backward-compat. */
function decodeExpression(json: string | null): ConditionTree | null {
    if (!json) return null;
    try {
        return validateConditionTree(JSON.parse(json));
    } catch {
        return null;
    }
}

/** Build an AND tree of equality leaves from the legacy `match_*` columns
 *  of a row. Used as the back-compat synthesis when `expression` is NULL,
 *  so the engine always reads a tree regardless of when the row was
 *  written. Empty AND → matches everything (a rule with zero conditions). */
export function synthesizeLegacyExpression(legacy: {
    match_project: string | null;
    match_kind: string | null;
    match_by_agent: string | null;
    match_intent: string | null;
    match_priority: string | null;
    match_tag_added: string | null;
    match_tags: string[];
    scope_consumer: string | null;
}): ConditionTree {
    const children: ConditionTree[] = [];
    if (legacy.match_project) children.push({ kind: "leaf", field: "project", op: "eq", value: legacy.match_project });
    if (legacy.match_kind) children.push({ kind: "leaf", field: "kind", op: "eq", value: legacy.match_kind });
    if (legacy.match_by_agent) children.push({ kind: "leaf", field: "by_agent", op: "eq", value: legacy.match_by_agent });
    if (legacy.match_intent) children.push({ kind: "leaf", field: "intent", op: "eq", value: legacy.match_intent });
    if (legacy.match_priority) children.push({ kind: "leaf", field: "priority", op: "eq", value: legacy.match_priority });
    if (legacy.match_tag_added) children.push({ kind: "leaf", field: "tag_added", op: "eq", value: legacy.match_tag_added });
    // match_tags is any-of : "the ticket carries ≥1 listed tag". Modeled as
    // OR(leaf:includes tag1, leaf:includes tag2, …) so each entry is a
    // first-class includes check on the event's `tags` field.
    if (legacy.match_tags.length > 0) {
        children.push({
            kind: "or",
            children: legacy.match_tags.map((t) => ({
                kind: "leaf" as const, field: "tags", op: "includes", value: t,
            })),
        });
    }
    // scope_consumer doesn't go into the expression — the engine still
    // narrows by it OUTSIDE the tree (it's a rule-level routing concern,
    // not a content match).
    return { kind: "and", children };
}

// ---------------------------------------------------------------------------
// Public rule shape (snake_case for API symmetry with the legacy Rule type).
// ---------------------------------------------------------------------------

export interface AutomationRule {
    id: number;
    /** A rule fires for any trigger in this list (david `8r7crj` : union). */
    triggers: Trigger[];
    scope_consumer: string | null;
    match_project: string | null;
    match_kind: string | null;
    match_by_agent: string | null;
    match_tags: string[];
    match_tag_added: string | null;
    match_intent: string | null;
    match_priority: string | null;
    action: AutomationAction;
    enabled: number;
    position: number;
    note: string | null;
    created_at: string;
    /** #457 slice 5.1 — the canonical match expression. ALWAYS populated on
     *  read : if the DB column was NULL (a legacy row pre-slice-5), the
     *  decoder synthesizes an AND tree of `eq` leaves from the `match_*`
     *  columns so the engine never has to branch on which generation
     *  wrote the rule. */
    expression: ConditionTree;
}

export interface NewAutomationRule {
    /** Accepts a single trigger (sugar) or a list (union). */
    triggers: Trigger | Trigger[];
    scope_consumer?: string | null;
    /** Slice 5.1 : the new "right" way to write a rule — a full condition
     *  tree. When set, the legacy `match_*` fields are ignored on insert.
     *  When absent, the legacy fields synthesize an AND-of-leaves tree at
     *  write time (so the column lands populated). */
    expression?: ConditionTree;
    match_project?: string | null;
    match_kind?: string | null;
    match_by_agent?: string | null;
    match_tags?: string[];
    match_tag_added?: string | null;
    match_intent?: string | null;
    match_priority?: string | null;
    action: AutomationAction;
    position?: number;
    note?: string | null;
}

// ---------------------------------------------------------------------------
// Encoders / decoders for the JSON columns.
// ---------------------------------------------------------------------------

function parseTags(json: string): string[] {
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
    } catch {
        return [];
    }
}

const VALID_TRIGGERS: Trigger[] = [
    "message_posted", "actionable_eval", "ticket_created", "ticket_tagged",
];

function parseTriggers(json: string): Trigger[] {
    try {
        const v = JSON.parse(json);
        if (!Array.isArray(v)) return [];
        return v.filter((t): t is Trigger =>
            typeof t === "string" && (VALID_TRIGGERS as string[]).includes(t),
        );
    } catch {
        return [];
    }
}

/**
 * Decode the (action_kind, action_data) column pair into the typed
 * discriminated union. Fail-open : an unknown kind / malformed JSON falls
 * back to a sentinel `decision:review` so the engine doesn't crash on a
 * row written by a future code path the current build doesn't recognize.
 */
function decodeAction(kind: string, dataJson: string): AutomationAction {
    let data: unknown = {};
    try { data = JSON.parse(dataJson); } catch { /* keep empty object */ }
    const d = (data ?? {}) as Record<string, unknown>;
    switch (kind) {
        case "decision":
            return { kind: "decision", decision: d.decision === "auto" ? "auto" : "review" };
        case "pickup":
            return { kind: "pickup", mode: d.mode === "except" ? "except" : "only" };
        case "assign":
            return { kind: "assign", consumer_id: typeof d.consumer_id === "string" ? d.consumer_id : "" };
        case "add_tag":
            return { kind: "add_tag", tag: typeof d.tag === "string" ? d.tag : "" };
        case "set_priority": {
            const p = typeof d.priority === "string" ? d.priority : "";
            const valid = (["urgent", "high", "normal", "low"] as const).find((v) => v === p);
            return { kind: "set_priority", priority: valid ?? "normal" };
        }
        case "notify":
            return { kind: "notify", consumer_id: typeof d.consumer_id === "string" ? d.consumer_id : "" };
        default:
            return { kind: "decision", decision: "review" };
    }
}

function encodeAction(a: AutomationAction): { kind: string; data: string } {
    // The discriminator is hoisted to action_kind ; the payload (minus `kind`)
    // is JSON-stringified into action_data. Stripping `kind` from the payload
    // avoids storing it twice (the schema discriminator IS action_kind).
    const { kind, ...rest } = a;
    return { kind, data: JSON.stringify(rest) };
}

function rowToRule(r: schema.AutomationRuleRow): AutomationRule {
    const matchTags = parseTags(r.matchTags);
    // #457 slice 5.1 : the engine always reads through `expression`. If the
    // column is non-null we decode it directly ; otherwise we synthesize an
    // AND tree from the legacy `match_*` columns so legacy + new rules
    // share one evaluation path.
    const parsed = decodeExpression(r.expression);
    const expression: ConditionTree =
        parsed ??
        synthesizeLegacyExpression({
            match_project: r.matchProject,
            match_kind: r.matchKind,
            match_by_agent: r.matchByAgent,
            match_intent: r.matchIntent,
            match_priority: r.matchPriority,
            match_tag_added: r.matchTagAdded,
            match_tags: matchTags,
            scope_consumer: r.scopeConsumer,
        });
    return {
        id: r.id,
        triggers: parseTriggers(r.triggers),
        scope_consumer: r.scopeConsumer,
        match_project: r.matchProject,
        match_kind: r.matchKind,
        match_by_agent: r.matchByAgent,
        match_tags: matchTags,
        match_tag_added: r.matchTagAdded,
        match_intent: r.matchIntent,
        match_priority: r.matchPriority,
        action: decodeAction(r.actionKind, r.actionData),
        enabled: r.enabled,
        position: r.position,
        note: r.note,
        created_at: r.createdAt,
        expression,
    };
}

// ---------------------------------------------------------------------------
// CRUD.
// ---------------------------------------------------------------------------

export function insertAutomationRule(r: NewAutomationRule): AutomationRule {
    const enc = encodeAction(r.action);
    const triggersList: Trigger[] = Array.isArray(r.triggers) ? r.triggers : [r.triggers];
    // #457 slice 5.1 : if the caller passes an explicit `expression`, that
    // wins ; else we synthesize one from the legacy `match_*` fields so the
    // column is never NULL going forward. Legacy rows already in the DB
    // keep their NULL `expression` ; rowToRule synthesizes on read.
    const expressionForCol: ConditionTree =
        r.expression ??
        synthesizeLegacyExpression({
            match_project: r.match_project ?? null,
            match_kind: r.match_kind ?? null,
            match_by_agent: r.match_by_agent ?? null,
            match_intent: r.match_intent ?? null,
            match_priority: r.match_priority ?? null,
            match_tag_added: r.match_tag_added ?? null,
            match_tags: r.match_tags ?? [],
            scope_consumer: r.scope_consumer ?? null,
        });
    const inserted = getDb().insert(schema.automationRules).values({
        triggers: JSON.stringify(triggersList),
        scopeConsumer: r.scope_consumer ?? null,
        matchProject: r.match_project ?? null,
        matchKind: r.match_kind ?? null,
        matchByAgent: r.match_by_agent ?? null,
        matchTags: JSON.stringify(r.match_tags ?? []),
        matchTagAdded: r.match_tag_added ?? null,
        matchIntent: r.match_intent ?? null,
        matchPriority: r.match_priority ?? null,
        actionKind: enc.kind,
        actionData: enc.data,
        enabled: 1,
        position: r.position ?? 0,
        note: r.note ?? null,
        createdAt: nowIso(),
        expression: JSON.stringify(expressionForCol),
    }).returning().get();
    return rowToRule(inserted);
}

export interface ListOpts {
    /** Filter to rules whose `triggers` JSON array contains this trigger. */
    trigger?: Trigger;
    scopeConsumer?: string;
    enabledOnly?: boolean;
}

export function listAutomationRules(opts: ListOpts = {}): AutomationRule[] {
    let q = getDb().select().from(schema.automationRules).$dynamic();
    const conds = [];
    if (opts.trigger) {
        // SQLite can't index inside JSON without a generated column. The
        // table will stay small so a LIKE on the JSON text is fine — we still
        // filter the result in JS below to drop any false-positive (e.g. a
        // tag with the same name accidentally matching). The pattern includes
        // the surrounding quotes so `"ticket"` doesn't match `"ticket_created"`.
        conds.push(like(schema.automationRules.triggers, `%"${opts.trigger}"%`));
    }
    if (opts.scopeConsumer !== undefined) {
        conds.push(eq(schema.automationRules.scopeConsumer, opts.scopeConsumer));
    }
    if (opts.enabledOnly) conds.push(eq(schema.automationRules.enabled, 1));
    if (conds.length) q = q.where(conds.length === 1 ? conds[0] : and(...conds));
    const rows = q.orderBy(asc(schema.automationRules.position), asc(schema.automationRules.id))
        .all()
        .map(rowToRule);
    // JS-side post-filter to drop LIKE false-positives — the trigger list IS
    // the authoritative source after JSON parse.
    if (opts.trigger) return rows.filter((r) => r.triggers.includes(opts.trigger!));
    return rows;
}

export function deleteAutomationRule(id: number): void {
    getDb().delete(schema.automationRules).where(eq(schema.automationRules.id, id)).run();
}

export function setAutomationRuleEnabled(id: number, enabled: boolean): AutomationRule | null {
    const db = getDb();
    db.update(schema.automationRules).set({ enabled: enabled ? 1 : 0 })
        .where(eq(schema.automationRules.id, id)).run();
    const r = db.select().from(schema.automationRules)
        .where(eq(schema.automationRules.id, id)).get();
    return r ? rowToRule(r) : null;
}

/**
 * Fail-open read for the engine : the enabled rules for a given trigger,
 * optionally narrowed to a consumer scope. Mirrors
 * `getEnabledWorkFiltersForConsumer` — a read error (migration 0039 not yet
 * applied on a hot-reloaded tsx daemon, transient DB issue, …) degrades to
 * `[]` so the engine fires nothing rather than crashing the caller.
 */
export function getEnabledRulesForTrigger(
    trigger: Trigger,
    scopeConsumer?: string,
): AutomationRule[] {
    try {
        const opts: ListOpts = { trigger, enabledOnly: true };
        if (scopeConsumer !== undefined) opts.scopeConsumer = scopeConsumer;
        return listAutomationRules(opts);
    } catch {
        return [];
    }
}
