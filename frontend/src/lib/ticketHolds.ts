/**
 * #3006 — which holds a thread's header shows. `claimant` stays filled after a
 * claim expires; only `is_claim` says whether it holds now, so an expired claim
 * is not shown. When the assignee is the live claimant, one chip says both
 * (its tooltip names the assignment); otherwise the assignment shows on its own
 * — an assignee whose claim expired must not vanish with the claim chip.
 */
export function headerHolds(t: { claimant?: string | null; is_claim?: boolean; assignee?: string | null }): {
    claimant: string | null;
    assignee: string | null;
} {
    const claimant = t.claimant && t.is_claim ? t.claimant : null;
    const assignee = t.assignee && t.assignee !== claimant ? t.assignee : null;
    return { claimant, assignee };
}
