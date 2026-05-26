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
import type { AutomationRule } from "../db/automation.js";

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
// Matcher.
// ---------------------------------------------------------------------------

/** Every NULL/empty condition is "any" ; every set one must match. Pure. */
function matchesCommon(rule: AutomationRule, project: string): boolean {
    if (rule.match_project && rule.match_project !== project) return false;
    return true;
}

function matchesTagsAnyOf(ruleTags: string[], ticketTags: string[]): boolean {
    if (ruleTags.length === 0) return true; // no tag condition → match
    const set = new Set(ticketTags);
    return ruleTags.some((t) => set.has(t));
}

/**
 * Does this rule fire for this event ? Pure — no side effects, no DB.
 * Callers iterate the candidate rules (already filtered by `enabled=1`
 * server-side) and call this per row.
 *
 * The rule's `triggers` list is a UNION (david `8r7crj`) : the rule fires
 * for ANY trigger in the list. Empty list = no triggers = never fires
 * (fail-closed against a malformed row).
 *
 * Each branch is fail-closed on its own attributes — a rule that sets a
 * condition the event can't satisfy (e.g. `match_tag_added` on a
 * `message_posted` event) never matches.
 */
export function ruleMatchesEvent(rule: AutomationRule, event: AutomationEvent): boolean {
    if (!rule.triggers.includes(event.trigger)) return false;
    if (!matchesCommon(rule, event.project)) return false;

    switch (event.trigger) {
        case "message_posted":
            if (rule.match_kind && rule.match_kind !== event.kind) return false;
            if (rule.match_by_agent && rule.match_by_agent !== event.by_agent) return false;
            // tags / intent / priority / tag_added : irrelevant for posts.
            return true;

        case "actionable_eval":
            // The scope_consumer narrows the candidate set server-side ; if it
            // somehow leaks here for another consumer, fail-closed.
            if (rule.scope_consumer && rule.scope_consumer !== event.consumer_id) return false;
            if (!matchesTagsAnyOf(rule.match_tags, event.ticket_tags)) return false;
            return true;

        case "ticket_created":
            if (rule.match_by_agent && rule.match_by_agent !== event.by_agent) return false;
            if (rule.match_intent && rule.match_intent !== event.intent) return false;
            if (rule.match_priority && rule.match_priority !== event.priority) return false;
            if (!matchesTagsAnyOf(rule.match_tags, event.ticket_tags)) return false;
            return true;

        case "ticket_tagged":
            // `match_tag_added` is the trigger-specific lever — fire only when
            // a SPECIFIC tag was just added. NULL = any tag-add event.
            if (rule.match_tag_added && rule.match_tag_added !== event.tag_added) return false;
            if (rule.match_intent && rule.match_intent !== event.intent) return false;
            if (rule.match_priority && rule.match_priority !== event.priority) return false;
            if (!matchesTagsAnyOf(rule.match_tags, event.ticket_tags)) return false;
            return true;
    }
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
