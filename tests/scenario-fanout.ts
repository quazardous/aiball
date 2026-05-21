// #324 e2e scenario — fan-out cinématique, driven through the BUSINESS API
// (POST /api/messages, GET /api/unread) against the real daemon in the
// container. Runs INSIDE the daemon container (`docker compose exec`): shares
// the DB (token minting) + reaches the daemon on localhost. If a scenario needs
// CRUD gymnastics to progress, that flags a missing business op (#cta34j).
import { issueToken } from "../src/db/tokens.js";
import { ensureConsumer } from "../src/db.js";

const url = "http://127.0.0.1:7777";
const project = "e2e";

function provision(consumer: string): string {
    ensureConsumer(consumer); // register the pseudo-agent before its token (FK)
    return issueToken({ kind: "agent", consumer_id: consumer, label: "e2e" }).token;
}

async function post(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${url}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST /api/messages → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

async function unread(token: string, consumer: string): Promise<Record<string, unknown>> {
    const r = await fetch(
        `${url}/api/unread?consumer_id=${encodeURIComponent(consumer)}&project=${project}&limit=100`,
        { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await r.text();
    if (!r.ok) throw new Error(`GET /api/unread → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
    const tokA = provision("agent-a");
    const tokB = provision("agent-b");

    // agent A opens a ticket → autoSubscribeAuthor subscribes A.
    const ticket = await post(tokA, { project, kind: "ticket_created", title: "fan-out e2e", by_agent: "agent-a" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;
    console.log(`ticket #${ticketId} created (status=${ticket.status})`);

    // agent B comments → fan-out should ping the subscriber (agent A).
    const comment = await post(tokB, {
        project,
        kind: "comment_added",
        ticket_id: ticketId,
        body: "hello A",
        by_agent: "agent-b",
        summary_until: "agent-b acknowledges the fan-out ticket", // required for agent comments
    });
    console.log(`comment ${comment.hashid ?? comment.id} added by agent-b (status=${comment.status})`);

    // assert: agent A has an unread for B's comment.
    const u = await unread(tokA, "agent-a");
    console.log("agent-a unread:", JSON.stringify(u).slice(0, 400));
    const count =
        (u.count as number) ??
        (u.pings as unknown[] | undefined)?.length ??
        (u.messages as unknown[] | undefined)?.length ??
        0;
    if (count < 1) {
        console.error("FAIL: agent-a received no fan-out ping for agent-b's comment");
        process.exit(1);
    }
    console.log(`OK: fan-out — agent-b's comment pinged agent-a (unread=${count})`);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
