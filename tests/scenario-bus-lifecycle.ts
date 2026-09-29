// #324 e2e — bus lifecycle (#321): an `onLifecycle` listener receives
// `created` / `moved` / `decided` EXACTLY once per mutation — the regression
// net for the dedup ("emit exactly once per mutation, no double-fire",
// event-bus.ts).
//
// Structurally different from the other scenarios: the lifecycle bus is an
// in-process EventEmitter (src/event-bus.ts), invisible from the shared daemon
// the others drive. So this one subscribes to `onLifecycle` in its own process
// and makes the mutations there, as bus calls (`asToken`: a token's caller,
// the bus's own checks — #3242). Shared test DB, its own projects: no
// interference with the daemon the other scenarios use.
// (#328 checklist : bus lifecycle #321)
import { asToken } from "../src/tests/bus-call.js";
import { onLifecycle, type LifecycleEvent } from "../src/event-bus.js";
import { provision, provisionProject, provisionHuman, metaDecision, ok, fail } from "./lib.js";

const project = "buslifecycle";
const dstProject = "buslifecycle-dst";

async function main(): Promise<void> {

    // S'abonner au bus lifecycle in-process AVANT toute mutation.
    const events: LifecycleEvent[] = [];
    const off = onLifecycle((e) => events.push(e));

    provisionProject(project);
    provisionProject(dstProject);
    const tokA = provision("agent-a"); // l'agent qui porte le ticket (reporter)
    const tokB = provision("agent-b"); // l'agent qui propose un plan
    const tokMod = provisionHuman("human-mod"); // moderates the agent's ticket before anyone plans on it

    async function call(token: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const r = await asToken<Record<string, unknown>>(token, method, params);
        if (r.status !== 200) throw new Error(`${method} → ${r.status}: ${JSON.stringify(r.json)}`);
        return r.json;
    }
    const post = (token: string, body: Record<string, unknown>) => call(token, "message.post", body);
    const decide = (token: string, id: number, status: "accepted" | "rejected") => call(token, "message.decide", { id, status });
    const move = (token: string, id: number, toProject: string) => call(token, "ticket.move", { id, project: toProject });

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

    // A plan is refused on a ticket still waiting for moderation: approve it
    // first, on this same in-process app, and start the next window after it.
    {
        const r = await asToken(tokMod, "message.approve", { id: ticketId });
        if (r.status !== 200) fail(`approving ticket #${ticketId} → ${r.status}: ${JSON.stringify(r.json)}`);
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
    ok("bus lifecycle — onLifecycle a reçu created/moved/decided, une seule fois chacun (#321 dédup)");
    process.exit(0);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
