/**
 * #2640 david — « est-ce que quand un agent pose un then:continue on lui dit
 * combien il reste de crédit ? ». The daemon answers `wait_credit` as JSON,
 * buried among the message fields. This turns it into one sentence the reply
 * tool puts first, so the agent reads what its wait cost and what is left.
 */
export interface WaitCreditAnswer {
    project: string;
    balance: number;
    refunded: number;
    step?: { requested: number; granted: number; spent: number };
    commits?: Array<{ commit: string; minutes: number; reason: string | null }>;
}

export function waitCreditNote(c: WaitCreditAnswer | null | undefined): string | null {
    if (!c) return null;
    const parts: string[] = [];
    if (c.refunded > 0) parts.push(`${c.refunded} min given back for coming back early`);
    const earned = (c.commits ?? []).reduce((s, x) => s + x.minutes, 0);
    if (earned > 0) parts.push(`${earned} min earned by your commits`);
    const unearned = (c.commits ?? []).filter((x) => x.minutes === 0);
    if (unearned.length) parts.push(`no credit for ${unearned.map((x) => `${x.commit} (${x.reason})`).join(", ")}`);
    if (c.step) {
        parts.push(c.step.granted < c.step.requested
            ? `this step waits ${c.step.granted} min, not the ${c.step.requested} asked: not enough credit`
            : `this step waits ${c.step.granted} min`);
    }
    if (!parts.length) return null;
    return `Wait credit on ${c.project}: ${parts.join("; ")}. ${c.balance} min left — earn more by closing tickets and citing commits; come back early to get the rest back.`;
}
