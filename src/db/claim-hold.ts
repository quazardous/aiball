/**
 * #2460 — the one answer to "until when does the claimant hold this ticket?",
 * for every reader: a rival's claim (#2379 protection), the step gate
 * (`then: continue`), the ticket header. The rule itself is pure, in
 * `assignment-gate.ts`; this reads what it needs.
 */
import { assignWindowSec } from "../autopoll/config.js";
import { claimHeldUntil, claimProtectionEnd } from "./assignment-gate.js";
import { getConfig } from "./config-overrides.js";
import { ticketSelfLastActivity } from "./tickets.js";

function protectMinutes(project: string): number {
    const raw = Number(getConfig("tickets.claim_protect_minutes", project) ?? 60);
    return Number.isFinite(raw) ? raw : 60;
}

/** When the #2379 protection of `holder`'s claim ends (ms), or null. */
export function claimProtectedUntil(holder: string, ticketId: number, claimedAt: string | null, project: string): number | null {
    const lastAction = ticketSelfLastActivity(holder, [ticketId]).get(ticketId) ?? null;
    return claimProtectionEnd(claimedAt, lastAction, protectMinutes(project));
}

/** When the claimant stops holding the ticket (ms), or null for no claim. */
export function ticketClaimHeldUntil(t: { id: number; project: string; claimant?: string | null; claimed_at?: string | null }): number | null {
    if (!t.claimant) return null;
    const lastAction = ticketSelfLastActivity(t.claimant, [t.id]).get(t.id) ?? null;
    return claimHeldUntil(t.claimed_at ?? null, lastAction, assignWindowSec() * 1000, protectMinutes(t.project));
}

/**
 * #3038 — `ticketClaimHeldUntil` for a page of tickets: one query per claimant
 * rather than one per ticket. Tickets without a claimant map to null.
 */
export function ticketsClaimHeldUntil(tickets: readonly { id: number; project: string; claimant?: string | null; claimed_at?: string | null }[]): Map<number, number | null> {
    const out = new Map<number, number | null>();
    const byClaimant = new Map<string, typeof tickets[number][]>();
    for (const t of tickets) {
        if (!t.claimant) { out.set(t.id, null); continue; }
        const list = byClaimant.get(t.claimant) ?? [];
        list.push(t);
        byClaimant.set(t.claimant, list);
    }
    const windowMs = assignWindowSec() * 1000;
    for (const [claimant, list] of byClaimant) {
        const lastActions = ticketSelfLastActivity(claimant, list.map((t) => t.id));
        for (const t of list) {
            out.set(t.id, claimHeldUntil(t.claimed_at ?? null, lastActions.get(t.id) ?? null, windowMs, protectMinutes(t.project)));
        }
    }
    return out;
}

/** #3038 — how a ticket is held: by its assignee, by a live claim, or a claim that lapsed. */
export type HeldAs = "assigned" | "claim" | "lapsed_claim";

/**
 * #3038 — who holds a ticket now, and how, so a client does not have to guess
 * from `assignee` and `claimant`. An assignment outranks a claim. A lapsed
 * claim stays on record (`claimant`) but holds nothing: its `holder` is null.
 * Pure: `heldUntilMs` comes from `ticketClaimHeldUntil`.
 */
export function holding(
    t: { assignee?: string | null; claimant?: string | null },
    heldUntilMs: number | null,
    nowMs: number,
): { holder: string | null; held_as: HeldAs | null } {
    if (t.assignee) return { holder: t.assignee, held_as: "assigned" };
    if (!t.claimant) return { holder: null, held_as: null };
    return heldUntilMs !== null && heldUntilMs > nowMs
        ? { holder: t.claimant, held_as: "claim" }
        : { holder: null, held_as: "lapsed_claim" };
}
