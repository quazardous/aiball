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
}

export interface NewAutomationRule {
    /** Accepts a single trigger (sugar) or a list (union). */
    triggers: Trigger | Trigger[];
    scope_consumer?: string | null;
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
    return {
        id: r.id,
        triggers: parseTriggers(r.triggers),
        scope_consumer: r.scopeConsumer,
        match_project: r.matchProject,
        match_kind: r.matchKind,
        match_by_agent: r.matchByAgent,
        match_tags: parseTags(r.matchTags),
        match_tag_added: r.matchTagAdded,
        match_intent: r.matchIntent,
        match_priority: r.matchPriority,
        action: decodeAction(r.actionKind, r.actionData),
        enabled: r.enabled,
        position: r.position,
        note: r.note,
        created_at: r.createdAt,
    };
}

// ---------------------------------------------------------------------------
// CRUD.
// ---------------------------------------------------------------------------

export function insertAutomationRule(r: NewAutomationRule): AutomationRule {
    const enc = encodeAction(r.action);
    const triggersList: Trigger[] = Array.isArray(r.triggers) ? r.triggers : [r.triggers];
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
