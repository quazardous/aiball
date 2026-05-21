// #324 e2e — self-ping filter (#296): an agent is pinged for OTHERS' comments on
// their ticket, but NOT for their own comment. Driven through the business API.
// (#328 checklist: self-ping / unreadCount)
import { provision, post, unread, ok, fail } from "./lib.js";

const project = "selfping";

async function main(): Promise<void> {
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");

    const ticket = await post(tokA, { project, kind: "ticket_created", title: "self-ping e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;

    // B comments → A should be pinged (positive control).
    await post(tokB, { project, kind: "comment_added", ticket_id: ticketId, body: "from B", by_agent: "agent-b", summary_until: "B comments" });
    // A comments on their own ticket → A should NOT be self-pinged.
    await post(tokA, { project, kind: "comment_added", ticket_id: ticketId, body: "from A (self)", by_agent: "agent-a", summary_until: "A self-comments" });

    const u = await unread(tokA, "agent-a", project);
    const msgs = (u.messages as Array<{ by_agent?: string }> | undefined) ?? [];
    console.log("agent-a unread by_agents:", JSON.stringify(msgs.map((m) => m.by_agent)));

    if (!msgs.some((m) => m.by_agent === "agent-b")) fail("agent-a should be pinged for agent-b's comment");
    if (msgs.some((m) => m.by_agent === "agent-a")) fail("agent-a should NOT be self-pinged for its own comment (#296)");
    ok("self-ping filtered — A pinged for B's comment, not for its own");
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
