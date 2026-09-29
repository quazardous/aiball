/**
 * #3249 — the rule "the ticket must be approved first", in one place: to
 * propose on a ticket (then: plan / resolved / wontfix / escalate), to decide a
 * proposal, and to claim it. The three used to write it apart, and the
 * `decision_proposable` flag ignored its exemptions (it told a human "no").
 *
 * - propose: a human is exempt (a moderator chains ticket, proposal and
 *   approve); a plan amending one already waiting passes (#2654).
 * - decide: nobody is exempt — the moderator approves the ticket, then decides.
 * - claim: a human is exempt (focus while moderating); a push-assignment is
 *   not a claim and is not gated.
 */
import { ERROR_CODES, type ErrorCode } from "./domain.js";

export type ModerationAction = "propose" | "decide" | "claim";

export interface ModerationRefusal { status: 409; error: string; code: ErrorCode }

export function moderationRefusal(
    action: ModerationAction,
    ticket: { status: string },
    opts: { human: boolean; decisionKind?: string | null; pendingPlan?: () => boolean },
): ModerationRefusal | null {
    if (ticket.status === "approved") return null;
    const code = ERROR_CODES.PARENT_PENDING_MODERATION;
    switch (action) {
        case "propose":
            if (opts.human) return null;
            if (opts.decisionKind === "plan" && opts.pendingPlan?.()) return null;
            return { status: 409, code, error: `cannot propose ${opts.decisionKind ?? "a decision"} on a ticket in status "${ticket.status}" — the reporter must moderate (approve) the ticket first ; post a plain comment_added (without "then:") until then` };
        case "decide":
            return { status: 409, code, error: `approve the ticket first (it is ${ticket.status}), then decide its proposal` };
        case "claim":
            if (opts.human) return null;
            return { status: 409, code, error: `cannot claim a ticket in status "${ticket.status}" — the reporter must moderate (approve) the ticket first` };
    }
}
