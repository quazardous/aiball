/**
 * #457 — automation engine matcher (pure, no DB, no I/O).
 *
 * The matcher takes a trigger event and a list of candidate rules, returns
 * the ones whose conditions match. Pure so the test suite covers every
 * trigger/condition combo without spinning up a daemon. Slice 1 ships the
 * matcher ; the LIFECYCLE HOOKS (what calls the engine and what runs the
 * returned actions) land in slice 2.
 *
 * Strategy : an `AutomationEvent` discriminated union per trigger carries
 * exactly the attributes that trigger emits. The matcher checks the rule's
 * `match_*` columns against the event payload — every `NULL` condition
 * means "any value", every set one must match.
 */
import type { AutomationRule, ConditionTree } from "../db/automation.js";

// ---------------------------------------------------------------------------
// Event shapes — one variant per trigger. Add a variant when you add a
// trigger ; the matcher's `match()` dispatches on `event.trigger`.
// ---------------------------------------------------------------------------

export interface MessagePostedEvent {
    trigger: "message_posted";
    project: string;
    kind: string;
    by_agent: string | null;
}

export interface ActionableEvalEvent {
    trigger: "actionable_eval";
    consumer_id: string;
    project: string;
    ticket_tags: string[];
}

export interface TicketCreatedEvent {
    trigger: "ticket_created";
    project: string;
    by_agent: string | null;
    intent: string | null;
    priority: string | null;
    ticket_tags: string[];
}

export interface TicketTaggedEvent {
    trigger: "ticket_tagged";
    project: string;
    /** The tag that was JUST added (or removed). Drives `match_tag_added`. */
    tag_added: string;
    /** All tags on the ticket AFTER the change — drives `match_tags` any-of. */
    ticket_tags: string[];
    intent: string | null;
    priority: string | null;
}

export type AutomationEvent =
    | MessagePostedEvent
    | ActionableEvalEvent
    | TicketCreatedEvent
    | TicketTaggedEvent;

// ---------------------------------------------------------------------------
// Matcher — slice 5.1 redesign.
//
// Trigger membership + scope_consumer routing stay at the RULE level
// (they're not "match content", they're "is this rule even a candidate
// for this event"). Everything else funnels through the recursive
// `evaluateExpression(tree, event)` — the source of truth for what a
// rule's conditions resolve to.
//
// Legacy rules (pre-slice-5, `expression` column NULL on disk) are
// indistinguishable here : `rowToRule` synthesizes an AND-of-leaves tree
// from the `match_*` columns at read time, so the engine always reads a
// populated `rule.expression`.
// ---------------------------------------------------------------------------

/** Extract the value of `field` from this event, or `undefined` if the
 *  event doesn't carry that field (e.g. `tag_added` on a message_posted
 *  event). The discriminant on `event.trigger` keeps TS happy. */
function readEventField(event: AutomationEvent, field: string): unknown {
    switch (event.trigger) {
        case "message_posted":
            if (field === "project") return event.project;
            if (field === "kind") return event.kind;
            if (field === "by_agent") return event.by_agent;
            return undefined;
        case "actionable_eval":
            if (field === "project") return event.project;
            if (field === "scope_consumer") return event.consumer_id;
            if (field === "tags") return event.ticket_tags;
            return undefined;
        case "ticket_created":
            if (field === "project") return event.project;
            if (field === "by_agent") return event.by_agent;
            if (field === "intent") return event.intent;
            if (field === "priority") return event.priority;
            if (field === "tags") return event.ticket_tags;
            return undefined;
        case "ticket_tagged":
            if (field === "project") return event.project;
            if (field === "tag_added") return event.tag_added;
            if (field === "tags") return event.ticket_tags;
            if (field === "intent") return event.intent;
            if (field === "priority") return event.priority;
            return undefined;
    }
}

/**
 * Recursive evaluator over the condition tree. Pure — no DB, no I/O.
 *
 * Semantics :
 *   - `and { children }` : every child must match. Empty children = true
 *     (vacuous AND), so a rule "with no conditions" matches everything.
 *   - `or  { children }` : at least one child must match. Empty children
 *     = false (vacuous OR — no way to satisfy).
 *   - `not { child }`    : the negation of the child.
 *   - `leaf { field, op, value }` : compare the leaf's `value` against the
 *     event's `field`. If the event doesn't carry that field (e.g. `tag_added`
 *     on a `message_posted` event), the leaf is FAIL-CLOSED → false. This
 *     mirrors the legacy "irrelevant condition = miss" semantics.
 *
 * Operator semantics :
 *   - `eq` / `neq` : strict equality on the event field. `null` compares
 *     equal to `null` (so a rule that targets "rules with no by_agent" still
 *     works). Coercion-free.
 *   - `in`         : leaf value is a string[] ; matches if event field ∈ value.
 *                    Useful for "intent in [request, question]" without a
 *                    nested OR.
 *   - `includes`   : event field is a string[] (tags) ; matches if value ∈ field.
 *                    "the ticket carries this tag".
 */
export function evaluateExpression(tree: ConditionTree, event: AutomationEvent): boolean {
    switch (tree.kind) {
        case "and":
            for (const c of tree.children) {
                if (!evaluateExpression(c, event)) return false;
            }
            return true;
        case "or":
            for (const c of tree.children) {
                if (evaluateExpression(c, event)) return true;
            }
            return false;
        case "not":
            return !evaluateExpression(tree.child, event);
        case "leaf": {
            const present = readEventField(event, tree.field);
            // Field not provided by this trigger → fail-closed.
            if (present === undefined) return false;
            switch (tree.op) {
                case "eq":
                    return present === tree.value;
                case "neq":
                    return present !== tree.value;
                case "in":
                    return Array.isArray(tree.value) && (tree.value as unknown[]).includes(present);
                case "includes":
                    return Array.isArray(present) && (present as unknown[]).includes(tree.value);
            }
        }
    }
}

/**
 * Does this rule fire for this event ? Pure — no side effects, no DB.
 * Callers iterate the candidate rules (already filtered by `enabled=1`
 * server-side) and call this per row.
 *
 * Two-stage filter :
 *   1. RULE-LEVEL routing : trigger membership (union, david `8r7crj`) +
 *      `scope_consumer` narrowing for `actionable_eval`. Empty triggers list
 *      fails closed against a malformed row.
 *   2. CONTENT match : delegated to `evaluateExpression(rule.expression, event)`.
 *      Slice 5.1 — the expression tree is the canonical source of truth ;
 *      legacy rows synthesize one at read time (db/automation.ts::rowToRule).
 */
export function ruleMatchesEvent(rule: AutomationRule, event: AutomationEvent): boolean {
    if (!rule.triggers.includes(event.trigger)) return false;
    // scope_consumer is a rule-level routing concern (not a content match),
    // so it stays here outside the tree. Mirrors the legacy actionable_eval
    // narrowing (when scope_consumer is set, the rule fires only for THAT
    // consumer's evaluations).
    if (event.trigger === "actionable_eval"
        && rule.scope_consumer
        && rule.scope_consumer !== event.consumer_id) {
        return false;
    }
    return evaluateExpression(rule.expression, event);
}

/**
 * **First-match-wins** semantics (david `x4pejb` : the default — "par défaut
 * une règle est first win donc l'ordre est important"). Returns the first
 * rule whose conditions match the event, or `null` when none do.
 *
 * `rules` are expected to come from `listAutomationRules` already ordered
 * by (position asc, id asc) — the engine doesn't re-sort.
 *
 * Use this for moderation (decision auto/review : the first matching rule
 * is the verdict), ticket_created/tagged action runs (the first matching
 * rule's action runs, the rest are skipped), and any new trigger where
 * "one action per event" is the natural shape.
 */
export function firstMatchingRule(
    rules: AutomationRule[],
    event: AutomationEvent,
): AutomationRule | null {
    return rules.find((r) => ruleMatchesEvent(r, event)) ?? null;
}

/**
 * **All-apply** semantics : returns every rule whose conditions match the
 * event, preserving caller-provided order.
 *
 * Use this for the work-filter (actionable_eval) gate where `except` rules
 * and `only` rules all contribute to the final verdict — narrowing here
 * to "first" would lose the AND/OR semantic the gate needs.
 */
export function allMatchingRules(
    rules: AutomationRule[],
    event: AutomationEvent,
): AutomationRule[] {
    return rules.filter((r) => ruleMatchesEvent(r, event));
}
