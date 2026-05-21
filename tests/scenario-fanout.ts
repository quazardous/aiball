// #324 e2e — fan-out: a comment by agent B on agent A's ticket pings the
// subscriber (A). Driven through the business API. (#328 checklist: fan-out)
import { provision, post, unread, ok, fail } from "./lib.js";

const project = "fanout";

async function main(): Promise<void> {
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");

    // agent A opens a ticket → autoSubscribeAuthor subscribes A.
    const ticket = await post(tokA, { project, kind: "ticket_created", title: "fan-out e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    console.log(`ticket #${ticketId} created (status=${ticket.status})`);

    // agent B comments → fan-out pings the subscriber (A).
    await post(tokB, {
        project,
        kind: "comment_added",
        ticket_id: ticketId,
        body: "hello A",
        by_agent: "agent-b",
        summary_until: "agent-b acknowledges the fan-out ticket",
    });

    const u = await unread(tokA, "agent-a", project);
    const count = (u.count as number) ?? (u.messages as unknown[] | undefined)?.length ?? 0;
    if (count < 1) fail("agent-a received no fan-out ping for agent-b's comment");
    ok(`fan-out — agent-b's comment pinged agent-a (unread=${count})`);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
