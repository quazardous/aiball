// #324 e2e — self-ping filter (#296): an agent is pinged for OTHERS' comments on
// their ticket, but NOT for their own comment. Driven through the business API.
// (#328 checklist: self-ping / unreadCount)
import { provision, provisionProject, post, unread, ok, fail } from "./lib.js";

const project = "selfping";

async function main(): Promise<void> {
    provisionProject(project);
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");

    const ticket = await post(tokA, { project, kind: "ticket_created", title: "self-ping e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;

    const unreadBy = async (): Promise<Array<string | undefined>> => {
        const u = await unread(tokA, "agent-a", project);
        return ((u.messages as Array<{ by_agent?: string }> | undefined) ?? []).map((m) => m.by_agent);
    };

    // B comments → A should be pinged (positive control). Read it BEFORE A
    // posts: posting on a thread acknowledges what was unread on it.
    await post(tokB, { project, kind: "comment_added", ticket_id: ticketId, body: "from B", by_agent: "agent-b", summary_until: "B comments", handback: true });
    const afterB = await unreadBy();
    console.log("agent-a unread by_agents after B:", JSON.stringify(afterB));
    if (!afterB.includes("agent-b")) fail("agent-a should be pinged for agent-b's comment");

    // A comments on their own ticket → A should NOT be self-pinged.
    await post(tokA, { project, kind: "comment_added", ticket_id: ticketId, body: "from A (self)", by_agent: "agent-a", summary_until: "A self-comments", handback: true });
    const afterA = await unreadBy();
    console.log("agent-a unread by_agents after A:", JSON.stringify(afterA));
    if (afterA.includes("agent-a")) fail("agent-a should NOT be self-pinged for its own comment (#296)");
    ok("self-ping filtered — A pinged for B's comment, not for its own");
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
