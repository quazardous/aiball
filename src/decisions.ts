/**
 * Decision-on-comment primitive (#B.129).
 *
 * A `comment_added` may carry an optional `meta.decision` block: the
 * author tags the comment as decisional (`kind`: plan / resolution /
 * extensible) and the reporter later accepts or rejects it.
 *
 * Stored in `messages.meta` (existing JSON sidecar, same field that
 * carries question answers from #B.104). String-pure helpers below
 * keep the data on one side and the DB / API plumbing on the other.
 *
 * Q1 retained: author tags at post-time (composer dropdown).
 * Q2 retained: this primitive will eventually subsume `ticket_resolved`
 *              — historical events stay readable, new flows emit a
 *              comment with `decision.kind="resolution"`. (Migration
 *              happens in the next phase.)
 * Q3 retained: most-recent-pending-decision wins. No order enforcement.
 * Q4 retained: v1 kinds = `plan` | `resolution`. `blocked` stays a
 *              separate lifecycle event (it's a signal, not a vote).
 */

import { DECISION_KINDS, kindsInFamily, type DecisionKind } from "./ticket-transitions.js";

// #802 — `wontfix` joined the set : an agent triaging a junk / out-of-scope /
// non-reproducible ticket can propose closure WITHOUT resolution via
// `ticket_reply({then:"wontfix"})`. Symmetric to `resolution` (pending = gated,
// reporter accept/reject) but accepting it ALSO auto-closes the ticket without
// flipping `resolved` — the ticket lands in `closed` state with no
// `resolved_by` / `resolved_at`. The acceptance side-effect lives in the
// api/messages.ts decide handler, NOT in this pure module.
// #737 — `escalation` joined the set : an agent that hits a blocker
// requiring human action (repo admin, infra, policy decision) posts
// `ticket_reply({then:"escalate"})`. Pending = ticket gated (the agent
// waits) ; accept = the human did the action (ticket re-enters actionable
// so the agent can continue any remaining work — NO auto-close, the ticket
// is not "done", just unblocked) ; reject = the human says "not an
// escalation" (ticket re-enters actionable, agent can re-classify).
// Gate semantics mirror `plan` (also a "waiting on someone" signal). At-
// insert side-effect : bumps the parent ticket's priority one notch
// (low→high, normal→high, high→urgent, urgent stays) so the human sees
// it at the top of their inbox. The bump lives in db/messages.ts insert
// path, NOT in this pure module.
// #2308 — the kinds come from the transition table (src/ticket-transitions.ts),
// the one place a decision's behaviour is defined. Re-exported for every
// existing importer.
export { DECISION_KINDS, type DecisionKind };

// #4458 — `withdrawn`: its author posted a step instead, so nothing is left to decide.
export const DECISION_STATUSES = ["pending", "accepted", "rejected", "withdrawn"] as const;
export type DecisionStatus = typeof DECISION_STATUSES[number];

// The two gate families, read from the table's `family` column (consumed by
// db/decision-gate.ts and the pending-decision surfaces):
//  - CLOSING : a proposal to END the ticket. pending OR accepted → gated
//    (close is imminent) ; rejected → ungated.
//  - WAITING : a "waiting on someone" signal. pending → gated ; accepted
//    (go / human acted) or rejected → ungated.
// The table is typed `satisfies Record<DecisionKind, DecisionGesture>`, so a
// kind without a row — or a row without a family — no longer typechecks.
export const CLOSING_DECISION_KINDS: readonly DecisionKind[] = kindsInFamily("closing");
export const WAITING_DECISION_KINDS: readonly DecisionKind[] = kindsInFamily("waiting");

/** #4459 — one of the choices a plan offers: the human picks one. */
export interface DecisionOption {
    key: string;
    label: string;
    /** The author's recommendation; at most one. */
    recommended?: boolean;
}

export interface CommentDecision {
    kind: DecisionKind;
    status: DecisionStatus;
    /** Filled when status transitions to accepted/rejected. */
    decided_by?: string;
    decided_at?: string;
    /** #4459 — the choices the plan offers, when it offers some. */
    options?: DecisionOption[];
    /** #4474 — whether several may be accepted together; said whenever there are options. */
    multiple?: boolean;
    /** #4459 — the key of the option accepted, on a plan that takes one. */
    option?: string;
    /** #4474 — the keys accepted on a `multiple` plan. */
    chosen?: string[];
}

/**
 * #4459 — the refusal for a plan's `options`, or null. Two to six, each with a
 * short key and a label, one recommended at most; only a plan offers them.
 */
export function optionsRefusal(options: unknown, kind: string | null, multiple?: unknown): string | null {
    if (kind !== "plan") return "options only go on a then: plan";
    // #4474 david — mandatory: exclusive or not is the author's to say, never a default.
    if (typeof multiple !== "boolean") return "options need multiple: true (the human may pick several) or false (exactly one)";
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) return "options must be 2 to 6 choices";
    const keys = new Set<string>();
    let recommended = 0;
    for (const o of options as Array<Partial<DecisionOption> | null>) {
        if (!o || typeof o.key !== "string" || !/^[A-Za-z0-9_-]{1,20}$/.test(o.key)) return "each option needs a short key (letters, digits, - or _, 20 at most)";
        if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 200) return `option ${o.key} needs a label of 200 characters at most`;
        if (keys.has(o.key)) return `option key ${o.key} is used twice`;
        keys.add(o.key);
        if (o.recommended === true) recommended++;
    }
    return recommended > 1 ? "only one option can be the recommended one" : null;
}

/**
 * #4459 — the refusal for accepting or rejecting with `option`, or null. A plan
 * with options is accepted on one of them: an accept with none is what left the
 * choice to be read from a comment.
 */
export function optionChoiceRefusal(decision: CommentDecision | undefined, status: string, option: unknown, options?: unknown): string | null {
    const offered = decision?.options;
    if (status !== "accepted") return option === undefined && options === undefined ? null : "option only goes with an accept";
    if (!offered?.length) return option === undefined && options === undefined ? null : "this decision offers no options";
    const keys = offered.map((o) => o.key).join(", ");
    if (decision?.multiple === true) {
        if (option !== undefined) return "this plan takes several: send options, a list";
        if (!Array.isArray(options) || options.length === 0) return `this plan offers options: accept at least one of ${keys}`;
        const bad = options.find((k) => !offered.some((o) => o.key === k));
        return bad === undefined ? null : `no option ${String(bad)} here: accept among ${keys}`;
    }
    if (options !== undefined) return "this plan takes exactly one: send option";
    if (option === undefined) return `this plan offers options: accept one of ${keys}`;
    return offered.some((o) => o.key === option) ? null : `no option ${String(option)} here: accept one of ${keys}`;
}

export function isDecisionKind(s: string): s is DecisionKind {
    return (DECISION_KINDS as readonly string[]).includes(s);
}

export function isDecisionStatus(s: string): s is DecisionStatus {
    return (DECISION_STATUSES as readonly string[]).includes(s);
}

/**
 * Apply an accept/reject to an existing decision sidecar. Returns the
 * new decision block and whether anything changed (idempotent: re-
 * applying the same status is a no-op).
 *
 * Throws when the decision can't be promoted (no decision present,
 * already terminal in a different direction). Callers should turn
 * these into 4xx responses.
 */
/**
 * Reclassify the kind of a pending decision WITHOUT accepting/rejecting
 * (#B.129 follow-up): "the agent tagged this as resolution but it's
 * really a plan — keep it pending, just change the verb". Throws when
 * the decision is missing or already terminal.
 */
export function reclassifyDecision(
    current: CommentDecision | undefined,
    newKind: DecisionKind,
): { decision: CommentDecision; changed: boolean } {
    if (!current) {
        throw new Error("no decision on this message — author must tag it first");
    }
    if (current.status !== "pending") {
        throw new Error(
            `decision already ${current.status} — reclassify requires the decision to still be pending`,
        );
    }
    if (current.kind === newKind) {
        return { decision: current, changed: false };
    }
    return {
        decision: { ...current, kind: newKind },
        changed: true,
    };
}

/**
 * Promote an undecorated comment into a decision (#B.256). Differs
 * from `reclassifyDecision` / `applyDecision`: those throw when the
 * comment has no prior decision, since reclassify/decide both assume
 * a decision exists. `promoteToDecision` is the post-hoc tag flow —
 * the reporter looks at a regular comment and either marks it as a
 * pending proposal (`status` omitted → pending) or as already-
 * accepted (`status="accepted"` → tagged + decided in one shot).
 *
 * If a decision already exists on the comment, this delegates to
 * the existing helpers so the API surface is symmetric:
 *   - `status` undefined → reclassify (kind only, must stay pending).
 *   - `status` set        → applyDecision (kind + final status).
 *
 * Returns the new decision block + whether anything changed (no-op
 * when the target state matches what's already there).
 */
export function promoteToDecision(
    current: CommentDecision | undefined,
    kind: DecisionKind,
    status?: Exclude<DecisionStatus, "pending">,
    by?: string,
    at?: string,
): { decision: CommentDecision; changed: boolean } {
    if (current) {
        if (status === undefined) {
            return reclassifyDecision(current, kind);
        }
        if (by === undefined || at === undefined) {
            throw new Error("promote with status= requires `by` and `at`");
        }
        return applyDecision(current, status, by, at, kind);
    }
    if (status === undefined) {
        return {
            decision: { kind, status: "pending" },
            changed: true,
        };
    }
    if (by === undefined || at === undefined) {
        throw new Error("promote with status= requires `by` and `at`");
    }
    return {
        decision: {
            kind,
            status,
            decided_by: by,
            decided_at: at,
        },
        changed: true,
    };
}

export function applyDecision(
    current: CommentDecision | undefined,
    next: DecisionStatus,
    by: string,
    at: string,
    /** Optional reclassification (#B.129 follow-up): the reporter can
     *  change the decision kind at the moment of accepting/rejecting
     *  — e.g. "this was tagged as a resolution but it's really just
     *  a plan, accept it as a plan". Without this, the kind stays
     *  whatever the author originally chose. */
    newKind?: DecisionKind,
    /** #4459 — the option accepted. */
    option?: string,
    /** #4474 — the options accepted, on a `multiple` plan. */
    chosen?: string[],
): { decision: CommentDecision; changed: boolean } {
    if (!current) {
        throw new Error("no decision on this message — author must tag it first");
    }
    if (next === "pending") {
        throw new Error("cannot reset a decision to pending");
    }
    const effectiveKind = newKind ?? current.kind;
    if (current.status === next && effectiveKind === current.kind) {
        return { decision: current, changed: false };
    }
    if (current.status !== "pending") {
        throw new Error(
            `decision already ${current.status} — re-tagging requires a new comment`,
        );
    }
    return {
        decision: {
            kind: effectiveKind,
            status: next,
            decided_by: by,
            decided_at: at,
            ...(current.options ? { options: current.options } : {}),
            ...(current.multiple !== undefined ? { multiple: current.multiple } : {}),
            ...(option !== undefined ? { option } : {}),
            ...(chosen !== undefined ? { chosen } : {}),
        },
        changed: true,
    };
}
