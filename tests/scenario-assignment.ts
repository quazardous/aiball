// #418 e2e — ticket → agent assignment / claim (multi-agent anti-collision),
// driven through the business API. The pure gate is covered in unit
// (src/db/assignment-gate.test.ts) and the in-process 2-agent simulation
// (src/db/assignment-flow.test.ts); here we audit the HTTP surface those can't
// reach: the claim/assign/release endpoints, push authority (an agent pushing
// onto ANOTHER consumer is moderator-only → 403), and auto-release on close.
import { provision, provisionHuman, post, tickets, assign, release, ok, fail, BASE } from "./lib.js";

const project = "assignment";

async function isActionable(token: string, ticketId: number): Promise<boolean> {
    const rows = await tickets(token, project, { actionable: true });
    return rows.some((t) => (t.id as number) === ticketId);
}
async function isOpen(token: string, ticketId: number): Promise<boolean> {
    const rows = await tickets(token, project, { open: true });
    return rows.some((t) => (t.id as number) === ticketId);
}

async function main(): Promise<void> {
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");
    const tokDavid = provisionHuman("david");

    // david (human) opens a ticket → shared pool: actionable for both agents.
    const t = await post(tokDavid, { project, kind: "ticket_created", title: "assignment e2e", by_agent: "david" });
    const id = (t.ticket_id ?? t.id) as number;
    if (!(await isActionable(tokA, id)) || !(await isActionable(tokB, id))) fail(`fresh #${id} should be in BOTH agents' pool`);
    ok(`#${id} in the shared pool (both agents)`);

    // agent-a CLAIMS it (no assignee = self-claim) → it leaves agent-b's pool.
    const claimed = await assign(tokA, id);
    if (claimed.is_claim !== true || claimed.assignee !== "agent-a") fail(`claim should set is_claim=true + assignee=agent-a, got ${JSON.stringify(claimed)}`);
    if (!(await isActionable(tokA, id))) fail(`#${id} should stay actionable for the claimer agent-a`);
    if (await isActionable(tokB, id)) fail(`#${id} should leave agent-b's pool after agent-a's claim`);
    if (!(await isOpen(tokB, id))) fail(`#${id} should still be OPEN for agent-b (just not in its court)`);
    ok(`#${id} claimed by agent-a → out of agent-b's pool, still open (anti-collision)`);

    // agent-b cannot PUSH it onto another consumer (moderator-only) → 403.
    const pushByAgent = await fetch(`${BASE}/api/tickets/${id}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokB}` },
        body: JSON.stringify({ assignee: "agent-a" }),
    });
    if (pushByAgent.status !== 403) fail(`an agent pushing onto another consumer should be 403, got ${pushByAgent.status}`);
    ok(`agent → push onto another consumer rejected (403, moderator-only)`);

    // david (human) PUSHES it onto agent-b → now agent-b's, not agent-a's.
    const pushed = await assign(tokDavid, id, "agent-b");
    if (pushed.is_claim !== false || pushed.assignee !== "agent-b") fail(`human push should set is_claim=false + assignee=agent-b`);
    if (!(await isActionable(tokB, id))) fail(`#${id} should be actionable for the pushed assignee agent-b`);
    if (await isActionable(tokA, id)) fail(`#${id} should leave agent-a's pool after the push to agent-b`);
    ok(`#${id} pushed onto agent-b by the human → out of agent-a's pool`);

    // release → back to the shared pool for everyone.
    await release(tokDavid, id);
    if (!(await isActionable(tokA, id)) || !(await isActionable(tokB, id))) fail(`released #${id} should be back in BOTH pools`);
    ok(`#${id} released → back in the shared pool`);

    // auto-release on close: push to agent-b, close, reopen → assignment gone
    // (agent-a sees it again — proves the close cleared the assignment, not just
    // the last_actor handover).
    await assign(tokDavid, id, "agent-b");
    if (await isActionable(tokA, id)) fail(`#${id} should be agent-b's alone before close`);
    await post(tokDavid, { project, kind: "ticket_closed", ticket_id: id, by_agent: "david" });
    await post(tokDavid, { project, kind: "ticket_reopened", ticket_id: id, by_agent: "david" });
    if (!(await isActionable(tokA, id))) fail(`#${id} should be back in agent-a's pool — close should have auto-released the assignment`);
    ok(`#${id} close auto-released the assignment → shared pool on reopen`);

    ok("assignment — claim / push authority / release / auto-release-on-close");
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
