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
