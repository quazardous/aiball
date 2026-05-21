// #324 e2e — decision-on-comment (#B.129): an agent proposes a plan (a comment
// tagged decision_kind=plan → pending); the reporter accepts it → the decision
// goes pending → accepted. Driven through the business API. (#328 checklist)
import { provision, post, decide, metaDecision, seedCounters, ok, fail } from "./lib.js";

const project = "decision";

async function main(): Promise<void> {
    seedCounters(); // address the comment by id later → avoid the fresh-DB id collision
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");

    const ticket = await post(tokA, { project, kind: "ticket_created", title: "decision e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;

    // agent B proposes a plan (decision_kind=plan → a pending decision).
    const plan = await post(tokB, {
        project,
        kind: "comment_added",
        ticket_id: ticketId,
        body: "plan: do X then Y",
        by_agent: "agent-b",
        summary_until: "agent-b proposes a plan",
        decision_kind: "plan",
    });
    const planId = plan.id as number;
    const before = metaDecision(plan);
    console.log(`plan #${planId} decision:`, JSON.stringify(before));
    if (before?.status !== "pending" || before?.kind !== "plan") fail(`expected a pending plan, got ${JSON.stringify(before)}`);

    // agent A (the reporter) accepts the plan.
    const decided = await decide(tokA, planId, "accepted");
    const after = metaDecision(decided);
    console.log("after decide:", JSON.stringify(after));
    if (after?.status !== "accepted" || after?.kind !== "plan") fail(`plan not accepted: ${JSON.stringify(after)}`);

    ok("decision-on-comment — plan pending → accepted (#B.129)");
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
