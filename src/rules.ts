/**
 * Moderation verdict — front-end to the unified automation engine (#483 / #457).
 *
 * Historique : ce module portait jadis son propre matcher sur la table legacy
 * `rules`. Depuis #483 il route sur `automation_rules` via
 * `firstMatchingRule(resolvedEnabledRulesForTrigger("message_posted"), event)`.
 * La signature publique (`evaluate(input) → {decision, matched_rule_id}`) ne
 * change pas — `messages.ts:392` reste inchangé. La table legacy `rules` est
 * retirée dans #465 (migration + drop).
 *
 * Structure : `decideFromRules` (pur, testable) — composé par `evaluate` qui
 * y ajoute le bypass `isHuman` + le fallback `strategyDefault`.
 */
import { effectiveStrategy, isHuman, type MessageKind, type RuleDecision, type Strategy } from "./db.js";
import { firstMatchingRule, type MessagePostedEvent } from "./automation/engine.js";
import { resolvedEnabledRulesForTrigger } from "./automation/resolved-rules.js";
import type { AutomationRule } from "./db/automation.js";

export interface RuleEvalInput {
    project: string;
    kind: MessageKind;
    by_agent: string | null;
}

export interface RuleEvalResult {
    decision: RuleDecision;
    matched_rule_id: number | null;
}

export function strategyDefault(s: Strategy, kind: MessageKind): RuleDecision {
    if (s === "auto") return "auto";
    if (s === "auto-reply" && kind === "comment_added") return "auto";
    return "review";
}

/**
 * Pur : first-match-wins sur la liste de rules `message_posted`. Renvoie le
 * verdict de la 1ère rule qui matche ET porte une action `decision`. Sinon
 * `null` — l'appelant (evaluate) tombe alors sur `strategyDefault`. Une rule
 * qui matche mais porte une autre action (misconfig) est ignorée comme si
 * elle n'avait pas matché.
 */
export function decideFromRules(
    rules: AutomationRule[],
    event: MessagePostedEvent,
): { decision: RuleDecision; matched_rule_id: number } | null {
    const rule = firstMatchingRule(rules, event);
    if (rule && rule.action.kind === "decision") {
        return { decision: rule.action.decision, matched_rule_id: rule.id };
    }
    return null;
}

/**
 * Evaluate first-match-wins. Le pool de rules vient de `automation_rules`
 * (DB ⊕ YAML, ordre position asc / id asc puis YAML appended) filtrées par
 * `trigger=message_posted`. Posts authored by a registered human actor
 * (#B.79) bypass moderation — le moderator EST l'approver. `isHuman()` lit la
 * table consumers ; la row "human" est backfillée par 0011.
 *
 * Sans match, on tombe sur la strategy en vigueur pour le projet (per-project
 * override → global default, per #B.127) : "manual" → review, "auto" → auto,
 * "auto-reply" → auto pour les comments, review pour tickets/closes.
 */
export function evaluate(input: RuleEvalInput): RuleEvalResult {
    if (input.by_agent && isHuman(input.by_agent)) {
        return { decision: "auto", matched_rule_id: null };
    }
    const event: MessagePostedEvent = {
        trigger: "message_posted",
        project: input.project,
        kind: input.kind,
        by_agent: input.by_agent ?? null,
    };
    const verdict = decideFromRules(resolvedEnabledRulesForTrigger("message_posted"), event);
    if (verdict) return verdict;
    return {
        decision: strategyDefault(effectiveStrategy(input.project), input.kind),
        matched_rule_id: null,
    };
}
