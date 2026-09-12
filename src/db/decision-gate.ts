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
//
// #1113 — raffinement de #600 : le raisonnement « le commentaire fire son
// propre wake FIFO » casse dès que ce ping est CONSOMMÉ (ticket_get/reply
// l'ack). Le backlog gaté devient alors le seul filet, et il est fermé → une
// question re-posée par l'humain sur une résolution pending périmée ne parvient
// jamais à l'agent (loop figée : b:1 mais aucun wake). Règle : une décision
// PENDING ne gate que tant que son PROPOSEUR reste le dernier acteur. Dès qu'un
// acteur foreign (≠ proposeur, ≠ `auto`) poste un commentaire plain, la
// proposition est moot → gate levé (symétrique de `resolution:rejected →
// UNGATE`). Les gates SETTLED (accepted / ticket_resolved legacy) ne trackent
// pas de proposeur → un commentaire tardif ne les lève pas (flux d'auto-close
// préservé). = « point 4 » (lastAuthor GO-override) différé de #273.

import { gateEffect } from "../ticket-transitions.js";

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
    /** #1113 — proposeur de la décision PENDING qui gate actuellement, ou null
     *  (pas gaté, OU gaté par un état SETTLED accepted/legacy qu'un commentaire
     *  foreign ne doit pas lever). Un commentaire plain d'un acteur ≠ proposeur
     *  lève le gate. */
    proposer: string | null;
}

/** #1113 — un acteur « foreign » relatif au proposeur de la décision pending :
 *  ni le proposeur lui-même, ni le marqueur de modération `auto`, ni null. */
function isForeignActor(actor: string | null, proposer: string | null): boolean {
    return !!actor && actor !== "auto" && actor !== proposer;
}

/**
 * Rejoue `events` (ordre id asc) et renvoie, par ticket, true s'il est gaté.
 * `isHuman` décide qui lève un gate pending : depuis #2376, seul un commentaire
 * HUMAIN le lève (celui d'un autre agent ne répond pas à la décision due).
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
                state.set(ev.ticketId, { gated: false, proposer: null });
            }
            continue;
        }

        if (ev.kind === "ticket_resolved") {
            // legacy : pending OU approved = ticket gaté (proposition ou settled).
            // proposer null : le path legacy ne participe pas au dé-gate
            // foreign-comment #1113 (conservateur — rare aujourd'hui).
            if (ev.status === "pending" || ev.status === "approved") {
                state.set(ev.ticketId, { gated: true, proposer: null });
            }
            continue;
        }

        // `ticket_created` carries a pending decision when filed via
        // `ticket_new({then:"plan"})` — its `meta.decision` lives on the
        // ticket row itself (see #961 fix in `decisionGateByTicket()`).
        const isDecisionBearing = ev.kind === "comment_added" || ev.kind === "ticket_created";
        if (!isDecisionBearing || ev.status !== "approved") continue;

        const decision = parseDecision(ev.meta);
        if (decision) {
            applyDecisionSignal(state, ev.ticketId, decision, ev.byAgent);
            continue;
        }
        // #1113 — commentaire plain. #600 le laissait no-op ; désormais un
        // commentaire d'un acteur FOREIGN pendant que le ticket est gaté par une
        // décision PENDING (proposer ≠ null) lève le gate : la proposition est
        // moot (l'autre a repris la parole au lieu d'accepter/rejeter). Un
        // commentaire du proposeur lui-même, ou sur un gate settled (proposer
        // null), reste no-op — la balle ne revient pas au backlog.
        //
        // #2376 david (a6zkyf) — "un commentaire de mon côté doit remettre le
        // ticket du côté agent, à sa charge de confirmer le then du ticket".
        // Seul un HUMAIN le fait : la décision lui appartient, donc sa parole
        // rend la main à l'agent, charge à lui de confirmer ou d'amender son
        // then: en attente. Un AUTRE AGENT qui parle ne répond à rien — la
        // décision reste due — donc le gate tient. Le commentaire declenche son
        // propre event dans les deux cas ; seul le backlog est en jeu ici.
        const st = state.get(ev.ticketId);
        const humanSpoke = !!ev.byAgent && isHuman(ev.byAgent);
        if (st?.gated && st.proposer !== null && isForeignActor(ev.byAgent, st.proposer) && humanSpoke) {
            state.set(ev.ticketId, { gated: false, proposer: null });
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
    byAgent: string | null,
): void {
    // #2308 — what each kind does at each status is the transition table's
    // `gate` column. #1113 — the proposer is tracked only while the hold can
    // be lifted by someone else speaking; a settled hold (an accepted
    // resolution / wontfix, close imminent) keeps proposer null so a late
    // comment does not lift it. An unknown kind or status stays inert.
    switch (gateEffect(decision.kind, decision.status)) {
        case "held_until_counterpart":
            state.set(ticketId, { gated: true, proposer: byAgent });
            return;
        case "held":
            state.set(ticketId, { gated: true, proposer: null });
            return;
        case "open":
            state.set(ticketId, { gated: false, proposer: null });
            return;
        case null:
            return;
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
