// #358 — logique pure du gate de décision, extraite de `decisionGateByTicket`
// (db/projects.ts) pour être testable sans DB, façon decisions.ts / search.ts.
//
// Le gate dit, par ticket, s'il est « gaté » (= retiré de l'actionable parce
// qu'une décision est en cours / le ticket est résolu). La règle historique
// est « dernier signal gagne » en rejouant les events dans l'ordre d'id.
//
// #358 ajoute la **récence** : une décision **pending** (proposition en
// attente de l'humain) cède à un `comment_added` HUMAIN postérieur — l'humain a
// répondu, la balle revient à l'agent, le ticket doit redevenir actionable.
// Les gates « settled » (résolution acceptée, ticket_resolved approuvé) ne
// cèdent PAS sur un simple commentaire : rouvrir un ticket résolu est un reopen
// explicite, pas un effet de bord d'un commentaire.

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
    // La proposition courante est-elle « pending » (donc cédable à un
    // commentaire humain) ? false pour les gates settled (accepted/approved).
    pendingProposal: boolean;
}

/**
 * Rejoue `events` (ordre id asc) et renvoie, par ticket, true s'il est gaté.
 * `isHuman(byAgent)` distingue un commentaire humain d'un commentaire d'agent :
 * un commentaire de l'agent après sa propre proposition n'ouvre PAS le gate
 * (il attend toujours l'humain).
 */
export function computeDecisionGate(
    events: Iterable<DecisionGateEvent>,
    isHuman: (consumerId: string) => boolean,
): Map<number, boolean> {
    const state = new Map<number, TicketGateState>();
    for (const ev of events) {
        if (ev.ticketId == null) continue;

        if (ev.kind === "ticket_reopened") {
            if (ev.status === "approved") {
                state.set(ev.ticketId, { gated: false, pendingProposal: false });
            }
            continue;
        }

        if (ev.kind === "ticket_resolved") {
            // legacy : pending = proposition cédable ; approved = résolu (settled).
            if (ev.status === "pending") {
                state.set(ev.ticketId, { gated: true, pendingProposal: true });
            } else if (ev.status === "approved") {
                state.set(ev.ticketId, { gated: true, pendingProposal: false });
            }
            continue;
        }

        if (ev.kind !== "comment_added" || ev.status !== "approved") continue;

        const decision = parseDecision(ev.meta);
        if (decision) {
            applyDecisionSignal(state, ev.ticketId, decision);
            continue;
        }

        // Commentaire plain (sans décision) : #358 — un commentaire HUMAIN
        // postérieur à une proposition pending ouvre le gate.
        const cur = state.get(ev.ticketId);
        if (cur?.gated && cur.pendingProposal && ev.byAgent != null && isHuman(ev.byAgent)) {
            state.set(ev.ticketId, { gated: false, pendingProposal: false });
        }
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
    if (decision.kind === "resolution") {
        if (decision.status === "pending") {
            state.set(ticketId, { gated: true, pendingProposal: true });
        } else if (decision.status === "accepted") {
            state.set(ticketId, { gated: true, pendingProposal: false });
        } else if (decision.status === "rejected") {
            state.set(ticketId, { gated: false, pendingProposal: false });
        }
    } else if (decision.kind === "plan") {
        // Plan accepté = go-signal → dé-gaté (le ticket re-rentre dans
        // l'actionable pour être exécuté). Plan rejeté = dé-gaté aussi.
        if (decision.status === "pending") {
            state.set(ticketId, { gated: true, pendingProposal: true });
        } else if (decision.status === "accepted" || decision.status === "rejected") {
            state.set(ticketId, { gated: false, pendingProposal: false });
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
