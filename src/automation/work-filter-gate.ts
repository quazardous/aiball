/**
 * #483 — work-filter gate sur le moteur unifié `automation_rules` (trigger
 * `actionable_eval`, action `pickup`).
 *
 * Remplace `db/work-filters.ts::ticketPassesWorkFilters` au call-site
 * `projects.ts:1421-1433`. La table legacy `work_filters` reste en place
 * jusqu'à #465 (qui copie les rows + drop la table + retire le module).
 *
 * ## Sémantique
 *
 * 1. Le matcher (`allMatchingRules`) applique toutes les conditions de
 *    chaque rule (project + tags + scope_consumer NULL=any), et ne
 *    renvoie que les rules qui matchent intégralement l'event.
 * 2. Sur la slice matched filtrée par `action.kind === "pickup"` :
 *      - Une rule `except` qui matche → exclure le ticket (`false`).
 *      - Une rule `only` qui matche → inclure (`true`).
 *      - Aucune rule matched → inclure (pass-through).
 *
 * ## Divergence vs legacy `ticketPassesWorkFilters`
 *
 * Le legacy splitait "applicabilité" (project) et "test" (tags) : une
 * `only`-rule applicable au projet du ticket mais dont les tags ne
 * matchaient pas EXCLUAIT le ticket (cf. work-filters.test.ts : "untagged
 * → excluded under an only-filter"). Dans le moteur unifié, le matcher
 * traite toutes les conditions d'un coup — une rule qui ne matche pas
 * n'a simplement pas d'avis sur le ticket. Pas de regression live (0 row
 * dans `work_filters` sur le runtime), et #465 choisira l'encodage des
 * rows migrées en conséquence.
 *
 * ## Structure
 *
 * `evaluatePickup(rules, event)` est PUR (testable sans DB). Le wrapper
 * `ticketPassesAutomationWorkFilter(consumer, project, tags)` fait le
 * read DB+YAML une fois par appel et délègue.
 */
import { allMatchingRules, type ActionableEvalEvent } from "./engine.js";
import { resolvedEnabledRulesForTrigger } from "./resolved-rules.js";
import type { AutomationRule } from "../db/automation.js";

/**
 * Predicate PUR : ce ticket survit-il aux `pickup` rules ?
 */
export function evaluatePickup(
    rules: AutomationRule[],
    event: ActionableEvalEvent,
): boolean {
    if (rules.length === 0) return true;
    const matchedPickups = allMatchingRules(rules, event)
        .filter((r) => r.action.kind === "pickup");
    if (matchedPickups.length === 0) return true;
    for (const r of matchedPickups) {
        if (r.action.kind === "pickup" && r.action.mode === "except") return false;
    }
    return true;
}

/**
 * Wrapper read-time : lit le pool de rules `actionable_eval` (DB+YAML
 * enabled), construit l'event, délègue à `evaluatePickup`.
 */
export function ticketPassesAutomationWorkFilter(
    consumerId: string,
    ticketProject: string,
    ticketTags: string[],
): boolean {
    const rules = resolvedEnabledRulesForTrigger("actionable_eval");
    const event: ActionableEvalEvent = {
        trigger: "actionable_eval",
        consumer_id: consumerId,
        project: ticketProject,
        ticket_tags: ticketTags,
    };
    return evaluatePickup(rules, event);
}
