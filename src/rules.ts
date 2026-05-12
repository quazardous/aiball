import {
    getStrategy,
    isHuman,
    listRules,
    type MessageKind,
    type Rule,
    type RuleDecision,
    type Strategy,
} from "./db.js";

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

function strategyDefault(s: Strategy, kind: MessageKind): RuleDecision {
    if (s === "auto") return "auto";
    if (s === "auto-reply" && kind === "comment_added") return "auto";
    return "review";
}

/**
 * Evaluate first-match-wins. Rules are ordered by (position ASC, id ASC).
 * Posts authored by a registered human actor (#B.79) bypass moderation
 * — the moderator IS the approver, re-routing their own posts through
 * the queue is busywork. `isHuman()` reads the actors table; the
 * literal `"human"` row is backfilled by migration 0011 so the bypass
 * works out of the box.
 *
 * If no rule matches, fall back to the global strategy: "manual" →
 * review, "auto" → auto, "auto-reply" → auto for comments, review for
 * tickets/closes.
 */
export function evaluate(input: RuleEvalInput): RuleEvalResult {
    if (input.by_agent && isHuman(input.by_agent)) {
        return { decision: "auto", matched_rule_id: null };
    }
    const rules = listRules({ enabledOnly: true });
    for (const r of rules) {
        if (ruleMatches(r, input)) {
            return { decision: r.decision, matched_rule_id: r.id };
        }
    }
    return {
        decision: strategyDefault(getStrategy(), input.kind),
        matched_rule_id: null,
    };
}
