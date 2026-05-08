import {
    getStrategy,
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
 * Posts authored by the human moderator (default `by_agent === "human"`,
 * which matches both the web composer's localStorage default and the CLI's
 * `-H/--human` default) skip moderation entirely. The moderator IS the
 * approver, so re-routing their own posts through the queue is busywork.
 *
 * If a deployment uses a different label, set AIBALL_HUMAN env on the daemon
 * to add that label to the bypass set. Multiple labels can be comma-separated.
 */
function humanLabels(): Set<string> {
    const env = process.env.AIBALL_HUMAN;
    const out = new Set<string>(["human"]);
    if (env) for (const part of env.split(",").map((s) => s.trim()).filter(Boolean)) out.add(part);
    return out;
}
const HUMAN_LABELS = humanLabels();

/**
 * Evaluate first-match-wins. Rules are ordered by (position ASC, id ASC).
 * Posts authored by a human bypass moderation. If no rule matches, fall back
 * to the global strategy: "manual" → review, "auto" → auto, "auto-reply" →
 * auto for comments, review for tickets/closes.
 */
export function evaluate(input: RuleEvalInput): RuleEvalResult {
    if (input.by_agent && HUMAN_LABELS.has(input.by_agent)) {
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
