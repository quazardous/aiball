// #324 e2e — bus lifecycle (#321) : un `onLifecycle` reçoit `created` / `moved`
// / `decided`, EXACTEMENT une fois par mutation — le filet de régression du
// dédup ("emit exactly once per mutation, no double-fire", event-bus.ts).
//
// STRUCTURELLEMENT DIFFÉRENT des autres scénarios : le bus lifecycle est un
// EventEmitter IN-PROCESS (src/event-bus.ts). On ne peut donc PAS l'observer
// par HTTP depuis le daemon partagé (autre process — son bus est invisible
// d'ici). On monte donc le VRAI app in-process (`createApp`, exactement
// l'affordance pour laquelle src/app.ts a été extrait) sur un port éphémère, et
// on s'abonne à `onLifecycle` dans LE MÊME process avant de driver la business
// API contre cette instance locale. DB de test partagée, projet distinct → pas
// d'interférence avec le daemon que les autres scénarios attaquent.
// (#328 checklist : bus lifecycle #321)
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { onLifecycle, type LifecycleEvent } from "../src/event-bus.js";
import { provision, seedCounters, metaDecision, ok, fail } from "./lib.js";

const project = "buslifecycle";
const dstProject = "buslifecycle-dst";

async function main(): Promise<void> {
    seedCounters(); // on décide un commentaire PAR id → on évite la collision d'id de DB fraîche

    // S'abonner au bus lifecycle in-process AVANT toute mutation.
    const events: LifecycleEvent[] = [];
    const off = onLifecycle((e) => events.push(e));

    // Monter le vrai app in-process et écouter sur un port éphémère.
    const server = createApp().listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const BASE = `http://127.0.0.1:${port}`;

    const tokA = provision("agent-a"); // l'agent qui porte le ticket (reporter)
    const tokB = provision("agent-b"); // l'agent qui propose un plan

    async function post(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const r = await fetch(`${BASE}/api/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`POST /api/messages → ${r.status}: ${text}`);
        return JSON.parse(text) as Record<string, unknown>;
    }
    async function decide(token: string, id: number, status: "accepted" | "rejected"): Promise<Record<string, unknown>> {
        const r = await fetch(`${BASE}/api/messages/${id}/decide`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ status }),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`POST /api/messages/${id}/decide → ${r.status}: ${text}`);
        return JSON.parse(text) as Record<string, unknown>;
    }
    async function move(token: string, id: number, toProject: string): Promise<Record<string, unknown>> {
        const r = await fetch(`${BASE}/api/tickets/${id}/move`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ project: toProject }),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`POST /api/tickets/${id}/move → ${r.status}: ${text}`);
        return JSON.parse(text) as Record<string, unknown>;
    }

    // Fenêtre d'événements lifecycle depuis le dernier checkpoint (= la
    // mutation qu'on vient de déclencher). C'est ce découpage par mutation qui
    // fait du test un filet anti-double-fire : 1 mutation = 1 événement attendu.
    let seen = 0;
    const fresh = (): LifecycleEvent[] => events.slice(seen);
    const checkpoint = (): void => { seen = events.length; };
    const tidOf = (e: LifecycleEvent): number | null => e.message.ticket_id ?? e.message.id;

    // --- 1) created : créer un ticket émet EXACTEMENT un `created`. ---
    const ticket = await post(tokA, { project, kind: "ticket_created", title: "bus lifecycle e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    {
        const f = fresh();
        const created = f.filter((e) => e.op === "created" && tidOf(e) === ticketId);
        if (created.length !== 1) fail(`ticket_created should emit exactly one 'created' lifecycle event, got ${created.length} [${f.map((e) => `${e.op}:${e.message.kind}`).join(", ")}]`);
        if (created[0].message.kind !== "ticket_created") fail(`'created' should carry kind=ticket_created, got ${created[0].message.kind}`);
        ok(`created — ticket #${ticketId} → exactement un 'created' (pas de double-fire)`);
        checkpoint();
    }

    // --- 2) created (comment) puis decided : un plan, puis son acceptation. ---
    const plan = await post(tokB, {
        project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-b",
        body: "plan: do X then Y", summary_until: "agent-b propose un plan, attend le go",
        decision_kind: "plan",
    });
    const planId = plan.id as number;
    {
        const created = fresh().filter((e) => e.op === "created" && e.message.kind === "comment_added");
        if (created.length !== 1) fail(`a plan comment should emit exactly one 'created' (kind=comment_added), got ${created.length}`);
        checkpoint();
    }

    const decided = await decide(tokA, planId, "accepted"); // agent-a (reporter) accepte le plan
    if (metaDecision(decided)?.status !== "accepted") fail(`plan not accepted: ${JSON.stringify(metaDecision(decided))}`);
    {
        const f = fresh();
        const dec = f.filter((e) => e.op === "decided");
        if (dec.length !== 1) fail(`accepting a decision should emit exactly one 'decided', got ${dec.length} [${f.map((e) => `${e.op}:${e.message.kind}`).join(", ")}]`);
        if (dec[0].message.id !== planId) fail(`'decided' should carry the decided comment #${planId}, got #${dec[0].message.id}`);
        ok(`decided — accept du plan #${planId} → exactement un 'decided' (pas de double-fire)`);
        checkpoint();
    }

    // --- 3) moved : déplacer le ticket cross-projet émet EXACTEMENT un `moved`
    //     (et surtout PAS un `created` parasite pour le commentaire d'audit). ---
    const moved = await move(tokA, ticketId, dstProject);
    if (moved.project !== dstProject) fail(`ticket not moved to "${dstProject}": project=${moved.project}`);
    {
        const f = fresh();
        const mv = f.filter((e) => e.op === "moved");
        if (mv.length !== 1) fail(`a move should emit exactly one 'moved', got ${mv.length} [${f.map((e) => `${e.op}:${e.message.kind}`).join(", ")}]`);
        if (tidOf(mv[0]) !== ticketId) fail(`'moved' should carry ticket #${ticketId}, got #${tidOf(mv[0])}`);
        // Le commentaire d'audit du move ne doit PAS émettre un 'created' en plus
        // (sinon une mutation = 2 événements → double-fire). C'est LE filet #321.
        const stray = f.filter((e) => e.op === "created");
        if (stray.length !== 0) fail(`a move must fire only 'moved', not also 'created' (dedup #321), saw ${stray.length}`);
        ok(`moved — ticket #${ticketId} "${project}"→"${dstProject}" → exactement un 'moved' (pas de double-fire)`);
        checkpoint();
    }

    off();
    await new Promise<void>((r) => server.close(() => r()));
    ok("bus lifecycle — onLifecycle a reçu created/moved/decided, une seule fois chacun (#321 dédup)");
    process.exit(0);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
