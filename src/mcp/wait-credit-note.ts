/**
 * #2640 david — « est-ce que quand un agent pose un then:continue on lui dit
 * combien il reste de crédit ? ». The daemon answers `wait_credit` as JSON,
 * buried among the message fields. This turns it into sentences the reply tool
 * puts first, so the agent reads what its wait cost and what is left.
 *
 * #2646 david — « quand l'agent n'a plus de crédit est-ce qu'on lui explique
 * que réagir sur un ticket redonne du temps ? » / « faut lui dire aussi pour
 * les commits ». How credit is earned is said with the project's configured
 * amounts (`rules`), commits included and how to cite them. An early return is
 * only promised when the wait actually spent something and refunds are on.
 */
export interface WaitCreditRules {
    floor: number;
    refund: boolean;
    resolved: number;
    resolved_no_commit: number;
    wontfix: number;
    commit_lines_per_minute: number;
    commit_max: number;
    commit_max_age_hours: number;
    max_commits_per_comment: number;
}

export interface WaitCreditAnswer {
    project: string;
    balance: number;
    refunded: number;
    step?: { requested: number; granted: number; spent: number };
    commits?: Array<{ commit: string; minutes: number; reason: string | null }>;
    rules?: WaitCreditRules;
}

/** How credit is earned, in the project's amounts. */
export function earnSentence(r: WaitCreditRules | undefined): string {
    if (!r) return "Earn more by getting tickets closed on your accepted resolutions and by citing your commits (`commits: [\"<sha>\"]` on a reply).";
    return `Credit comes back when a ticket closes on your accepted resolution (+${r.resolved} min with a commit cited on that ticket, +${r.resolved_no_commit} without) or wontfix (+${r.wontfix}), `
        + `and with each commit you cite on a reply as \`commits: ["<sha>"]\` (+1 min per ${r.commit_lines_per_minute} changed lines, ${r.commit_max} max, at most ${r.commit_max_age_hours} h old, ${r.max_commits_per_comment} per comment).`;
}

export function waitCreditNote(c: WaitCreditAnswer | null | undefined): string | null {
    if (!c) return null;
    const parts: string[] = [];
    if (c.refunded > 0) parts.push(`${c.refunded} min given back for coming back early`);
    const earned = (c.commits ?? []).reduce((s, x) => s + x.minutes, 0);
    if (earned > 0) parts.push(`${earned} min earned by your commits`);
    const unearned = (c.commits ?? []).filter((x) => x.minutes === 0);
    if (unearned.length) parts.push(`no credit for ${unearned.map((x) => `${x.commit} (${x.reason})`).join(", ")}`);
    const capped = !!c.step && c.step.granted < c.step.requested;
    if (c.step) parts.push(capped ? `this step waits ${c.step.granted} min, not the ${c.step.requested} asked` : `this step waits ${c.step.granted} min`);
    if (!parts.length) return null;

    const out = capped || c.balance <= 0;
    const head = out
        ? `You are out of wait credit on ${c.project}: ${parts.join("; ")}. ${Math.max(c.balance, 0)} min left.`
        : `Wait credit on ${c.project}: ${parts.join("; ")}. ${c.balance} min left.`;
    const refund = c.step && c.step.spent > 0 && c.rules?.refund !== false
        ? " Coming back on this ticket before the wait ends gives back what it has not used."
        : "";
    return `${head}${refund} ${earnSentence(c.rules)}`;
}
