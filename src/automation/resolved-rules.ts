/**
 * #457 slice 3 — resolved rules : the engine's candidate pool = DB rules
 * (operator-managed via UI) **followed by** YAML rules (versioned defaults).
 *
 * This is the layering direction the rest of aiball follows (russian-doll
 * with operator wins). With first-match-wins semantics, "DB before YAML"
 * means : an operator who creates a rule in the UI **overrides** any
 * lower-priority YAML default that would have matched the same event.
 *
 * Both layers are filtered to `enabled=1` before they reach the engine.
 * Within each layer, the natural order is preserved (DB : position asc / id
 * asc, set by the CRUD ; YAML : declaration order).
 */
import type { AutomationRule, Trigger } from "../db/automation.js";
import { getEnabledRulesForTrigger } from "../db/automation.js";
import { loadYamlAutomationRules } from "./yaml.js";

/**
 * Return every enabled rule that fires for `trigger`, in iteration order :
 * DB rules first, YAML rules second. Optionally narrowed to a consumer scope
 * (used by `actionable_eval`).
 *
 * Cheap fail-open : a YAML read failure logs through `loadYamlAutomationRules`
 * and falls back to an empty layer, so a malformed YAML never breaks the DB
 * rules path. Re-reads YAML on every call — files are tiny, the cost is dwarfed
 * by the DB query — keeps the read-time view in sync with the file (no
 * reload-on-USR2 plumbing to maintain).
 */
export function resolvedEnabledRulesForTrigger(
    trigger: Trigger,
    scopeConsumer?: string,
): AutomationRule[] {
    const db = getEnabledRulesForTrigger(trigger, scopeConsumer);
    const yaml = loadYamlAutomationRules().filter((r) => {
        if (!r.enabled) return false;
        if (!r.triggers.includes(trigger)) return false;
        if (scopeConsumer !== undefined && r.scope_consumer !== null && r.scope_consumer !== scopeConsumer) {
            return false;
        }
        return true;
    });
    return [...db, ...yaml];
}
