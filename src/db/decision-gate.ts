// #358 — logique pure du gate de décision, extraite de `decisionGateByTicket`
// (db/projects.ts) pour être testable sans DB, façon decisions.ts / search.ts.
//
// Le gate dit, par ticket, s'il est « gaté » (= retiré de l'actionable parce
// qu'une décision est en cours / le ticket est résolu). La règle historique
// est « dernier signal gagne » en rejouant les events dans l'ordre d'id.
//
// #600 v7z5u6 — un commentaire humain (ou agent) plain ne lève PAS le gate
// pending : tant que la décision n'est pas explicitement accept/reject, le
// ticket reste hors du backlog wake. Le commentaire fire de toute façon son
// propre wake (FIFO unread) → l'agent voit le signal sans que la balle revienne
// au backlog. Réouvrir le ticket = accept ou reject la proposition pending.

/** Un event pertinent pour le gate, fourni dans l'ordre d'insertion (id asc). */
export interface DecisionGateEvent {
    ticketId: number | null;
    kind: string; // ticket_resolved | ticket_reopened | comment_added
    status: string; // approved | pending | rejected
    meta: string | null; // JSON ; peut porter meta.decision = { kind, status }
    byAgent: string | null;
}

interface TicketGateState {
    gated: boolean;
}

/**
 * Rejoue `events` (ordre id asc) et renvoie, par ticket, true s'il est gaté.
 * `isHuman` est conservé pour back-compat de signature ; il n'est plus consulté
 * depuis #600 v7z5u6 (un commentaire plain ne lève plus une décision pending).
 */
export function computeDecisionGate(
    events: Iterable<DecisionGateEvent>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _isHuman: (consumerId: string) => boolean,
): Map<number, boolean> {
    const state = new Map<number, TicketGateState>();
    for (const ev of events) {
        if (ev.ticketId == null) continue;

        if (ev.kind === "ticket_reopened") {
            if (ev.status === "approved") {
                state.set(ev.ticketId, { gated: false });
            }
            continue;
        }

        if (ev.kind === "ticket_resolved") {
            // legacy : pending OU approved = ticket gaté (proposition ou settled).
            if (ev.status === "pending" || ev.status === "approved") {
                state.set(ev.ticketId, { gated: true });
            }
            continue;
        }

        // #803 — `ticket_created` with a pending plan decision in its meta
        // joins the same replay (decisionGateByTicket re-maps the row's id
        // to ticketId for ticket_created events).
        const isDecisionBearing = ev.kind === "comment_added" || ev.kind === "ticket_created";
        if (!isDecisionBearing || ev.status !== "approved") continue;

        const decision = parseDecision(ev.meta);
        if (decision) {
            applyDecisionSignal(state, ev.ticketId, decision);
        }
        // Plain comment (no decision meta) = no-op on the gate. The comment
        // still fires a FIFO unread wake so the agent sees the human reply ;
        // resolving the gate requires accept/reject on the pending proposal.
    }

    const gated = new Map<number, boolean>();
    for (const [id, st] of state) gated.set(id, st.gated);
    return gated;
}

function applyDecisionSignal(
    state: Map<number, TicketGateState>,
    ticketId: number,
    decision: { kind?: string; status?: string },
): void {
    if (decision.kind === "resolution" || decision.kind === "wontfix") {
        // #802 — wontfix shares resolution's gate semantics : pending OR
        // accepted = ticket gated. Difference is in the side-effect
        // (acceptance auto-closes the ticket, see api/messages.ts decide
        // handler) ; the gate replay treats them identically.
        if (decision.status === "pending" || decision.status === "accepted") {
            state.set(ticketId, { gated: true });
        } else if (decision.status === "rejected") {
            state.set(ticketId, { gated: false });
        }
    } else if (decision.kind === "plan") {
        // Plan accepté = go-signal → dé-gaté (le ticket re-rentre dans
        // l'actionable pour être exécuté). Plan rejeté = dé-gaté aussi.
        if (decision.status === "pending") {
            state.set(ticketId, { gated: true });
        } else if (decision.status === "accepted" || decision.status === "rejected") {
            state.set(ticketId, { gated: false });
        }
    }
}

function parseDecision(meta: string | null): { kind?: string; status?: string } | null {
    if (!meta) return null;
    try {
        const m = JSON.parse(meta) as { decision?: { kind?: string; status?: string } };
        return m.decision ?? null;
    } catch {
        return null;
    }
}
