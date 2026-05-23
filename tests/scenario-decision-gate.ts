// #324 e2e — gate de décision (#273) : last-signal-per-ticket-wins. Un ticket
// SORT du pool `actionable` quand une décision pending est posée, et y REVIENT
// quand l'humain répond (règle récence #358 — la balle repasse à l'agent), puis
// re-sort sur une nouvelle proposition pending (le dernier signal gagne).
// Driven through the business API. La logique pure est déjà couverte en unit
// (src/db/decision-gate.test.ts, 14 cas) ; ici on audite le scénario business
// de bout en bout via le daemon réel. (#328 checklist : gate de décision #273)
import { provision, provisionHuman, post, tickets, ok, fail } from "./lib.js";

const project = "decisiongate";

/** L'id du ticket est-il dans le pool `actionable` du porteur de `token` ? */
async function isActionable(token: string, ticketId: number): Promise<boolean> {
    const rows = await tickets(token, project, { actionable: true });
    return rows.some((t) => (t.id as number) === ticketId);
}

async function main(): Promise<void> {
    const tokA = provision("agent-a"); // l'agent qui porte le ticket
    const tokDavid = provisionHuman("david"); // l'humain (kind=human → compte pour #358)

    // david (humain) dépose un ticket → bypass modération = approuvé d'emblée
    // (un agent-author serait `review`/pending sous la stratégie auto-reply du
    // daemon de test, donc hors openIds, donc jamais actionable). Flow canonique :
    // l'humain ouvre, l'agent porte → actionable pour agent-a, aucune décision.
    const ticket = await post(tokDavid, { project, kind: "ticket_created", title: "decision gate e2e", by_agent: "david" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    if (!(await isActionable(tokA, ticketId))) fail(`fresh ticket #${ticketId} should be actionable for the working agent`);
    ok(`#${ticketId} actionable au départ (aucune décision en cours)`);

    // 1) agent-a propose un plan (decision pending) → le gate SORT le ticket de l'actionable.
    await post(tokA, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-a",
        body: "plan: je ferai X puis Y", summary_until: "agent-a propose un plan, attend le go",
        decision_kind: "plan",
    });
    if (await isActionable(tokA, ticketId)) fail(`#${ticketId} should leave actionable while a plan decision is pending`);
    ok(`#${ticketId} hors actionable tant que la décision est pending (#273)`);

    // 2) david (humain) répond en commentaire plain → règle récence #358 : la
    //    proposition pending cède au commentaire humain postérieur, la balle
    //    revient à l'agent → le ticket RE-rentre dans l'actionable.
    await post(tokDavid, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "david",
        body: "go, mais commence par Y",
    });
    if (!(await isActionable(tokA, ticketId))) fail(`#${ticketId} should re-enter actionable after a later human comment (#358)`);
    ok(`#${ticketId} re-actionable après le commentaire humain (récence #358)`);

    // 3) agent-a re-propose un plan pending → last-signal-per-ticket-wins : le
    //    dernier signal (pending) prime et re-gate le ticket.
    await post(tokA, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-a",
        body: "nouveau plan: Y puis Z", summary_until: "agent-a re-propose un plan après le retour de david",
        decision_kind: "plan",
    });
    if (await isActionable(tokA, ticketId)) fail(`#${ticketId} should leave actionable again on a newer pending decision (last-signal-wins)`);
    ok(`#${ticketId} re-gaté par la nouvelle décision pending (last-signal-per-ticket-wins)`);

    ok("decision gate — pending sort, humain ré-entre (#358), nouveau pending re-sort (#273)");
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
