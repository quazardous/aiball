import { listRules, type MessageKind, type Rule, type RuleDecision } from "./db.js";

export interface RuleEvalInput {
    project: string;
    kind: MessageKind;
    by_agent: string | null;
}

export interface RuleEvalResult {
    decision: RuleDecision;
    matched_rule_id: number | null;
}

function ruleMatches(rule: Rule, input: RuleEvalInput): boolean {
    if (rule.match_project && rule.match_project !== input.project) return false;
    if (rule.match_kind && rule.match_kind !== input.kind) return false;
    if (rule.match_by_agent && rule.match_by_agent !== input.by_agent) return false;
    return true;
}

/**
 * Evaluate first-match-wins. Rules are ordered by (position ASC, id ASC).
 * If no rule matches, default decision is "review".
 */
export function evaluate(input: RuleEvalInput): RuleEvalResult {
    const rules = listRules({ enabledOnly: true });
    for (const r of rules) {
        if (ruleMatches(r, input)) {
            return { decision: r.decision, matched_rule_id: r.id };
        }
    }
    return { decision: "review", matched_rule_id: null };
}
