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
        const st = state.get(ev.ticketId);
        if (st?.gated && st.proposer !== null && isForeignActor(ev.byAgent, st.proposer)) {
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
    if (decision.kind === "resolution" || decision.kind === "wontfix") {
        // #802 — wontfix shares resolution's gate semantics : pending OR
        // accepted = ticket gated. Difference is in the side-effect
        // (acceptance auto-closes the ticket, see api/messages.ts decide
        // handler) ; the gate replay treats them identically.
        // #1113 — proposer tracké seulement sur PENDING (levable par un
        // commentaire foreign) ; sur `accepted` le gate est settled (close
        // imminente) → proposer null, pas de levée sur commentaire tardif.
        if (decision.status === "pending") {
            state.set(ticketId, { gated: true, proposer: byAgent });
        } else if (decision.status === "accepted") {
            state.set(ticketId, { gated: true, proposer: null });
        } else if (decision.status === "rejected") {
            state.set(ticketId, { gated: false, proposer: null });
        }
    } else if (decision.kind === "plan" || decision.kind === "escalation") {
        // Plan accepté = go-signal → dé-gaté (le ticket re-rentre dans
        // l'actionable pour être exécuté). Plan rejeté = dé-gaté aussi.
        // #737 — escalation partage les mêmes sémantiques de gate :
        // pending = gated (l'agent attend l'action humaine), accept = the
        // human did the action → dé-gaté (l'agent re-rentre dans l'actionable
        // pour suite éventuelle, PAS d'auto-close), reject = "not an
        // escalation" → dé-gaté aussi (l'agent peut re-classifier).
        if (decision.status === "pending") {
            state.set(ticketId, { gated: true, proposer: byAgent });
        } else if (decision.status === "accepted" || decision.status === "rejected") {
            state.set(ticketId, { gated: false, proposer: null });
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
