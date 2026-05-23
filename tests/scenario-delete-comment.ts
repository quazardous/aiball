// #324 e2e — delete comment (#309, #328 checklist q:42e8c9): a HUMAN moderator
// soft-deletes a comment → it becomes a tombstone (status="rejected" +
// meta.deleted={by,at}), drops out of the normal thread / comment_count / ping
// counts, and only re-surfaces (body-stripped) under ?include_deleted=1. Agents
// can't delete (403); non-comments can't be deleted (400).
//
// Driven over HTTP against the shared daemon. Addresses a comment BY ID
// (POST /api/messages/:id/delete), so seedCounters() pushes next_message_id
// above the ticket-id space (getMessage is tickets-first — a comment id
// colliding with a ticket id would misresolve). Distinct project "deletecomment".
import { provision, provisionHuman, post, unread, seedCounters, ok, fail, BASE } from "./lib.js";

const project = "deletecomment";

async function getTicket(token: string, id: number, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(query).toString();
    const r = await fetch(`${BASE}/api/tickets/${id}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET /api/tickets/${id} → ${r.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

/** Raw delete — returns the HTTP code so the negative cases (403/400) can assert it. */
async function attemptDelete(token: string, id: number): Promise<{ code: number; body: Record<string, unknown> | null }> {
    const r = await fetch(`${BASE}/api/messages/${id}/delete`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const text = await r.text();
    return { code: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function parseMetaField(m: Record<string, unknown>): Record<string, unknown> {
    const raw = m.meta;
    if (!raw) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

function commentIds(thread: Record<string, unknown>): number[] {
    return ((thread.comments as Array<Record<string, unknown>>) ?? []).map((c) => c.id as number);
}

async function main(): Promise<void> {
    seedCounters(); // we address a comment by id (/delete) → dodge the ticket/message id collision

    const tokHuman = provisionHuman("human-mod"); // the only actor allowed to delete; also opens the ticket (→ subscribed)
    const tokA = provision("agent-a"); // author of the comment that gets deleted
    const tokB = provision("agent-b"); // author of a comment that STAYS (proves the delete is targeted)

    const ticket = await post(tokHuman, { project, kind: "ticket_created", title: "delete-comment e2e", by_agent: "human-mod" });
    const ticketId = (ticket.ticket_id ?? ticket.id) as number;

    const cA = await post(tokA, { project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-a", body: "agent-a comment (to be deleted)", summary_until: "agent-a commented" });
    const cB = await post(tokB, { project, kind: "comment_added", ticket_id: ticketId, by_agent: "agent-b", body: "agent-b comment (stays)", summary_until: "agent-b commented" });
    const cAId = cA.id as number;
    const cBId = cB.id as number;

    // --- baseline: both comments live, counted, and cA pinged the subscriber. ---
    const before = await getTicket(tokHuman, ticketId, { full: "1" });
    if (!commentIds(before).includes(cAId) || !commentIds(before).includes(cBId)) {
        fail(`baseline thread should contain both comments, got ids=${JSON.stringify(commentIds(before))}`);
    }
    const countBefore = (await getTicket(tokHuman, ticketId)).comment_count as number;
    if (countBefore !== 2) fail(`baseline comment_count should be 2, got ${countBefore}`);
    const unreadBefore = (((await unread(tokHuman, "human-mod", project)).messages as Array<{ id?: number }>) ?? []).map((m) => m.id);
    if (!unreadBefore.includes(cAId)) fail(`human-mod should have a ping for cA #${cAId} before delete, got ${JSON.stringify(unreadBefore)}`);
    ok(`baseline — both comments live (count=2), cA #${cAId} pinged the subscriber`);

    // --- guard: agents can't delete (403), and non-comments can't be deleted (400). ---
    const agentTry = await attemptDelete(tokA, cAId);
    if (agentTry.code !== 403) fail(`an agent deleting a comment should get 403, got ${agentTry.code} (${JSON.stringify(agentTry.body)})`);
    ok("guard — agent-a's delete attempt rejected 403 (human-moderator only)");

    const ticketTry = await attemptDelete(tokHuman, ticketId);
    if (ticketTry.code !== 400) fail(`deleting a non-comment (ticket head) should get 400, got ${ticketTry.code} (${JSON.stringify(ticketTry.body)})`);
    ok("guard — deleting the ticket head rejected 400 (only comments can be deleted)");

    // --- act: the human soft-deletes cA. ---
    const del = await attemptDelete(tokHuman, cAId);
    if (del.code !== 200 || !del.body) fail(`human delete of cA should be 200, got ${del.code} (${JSON.stringify(del.body)})`);
    if (del.body.status !== "rejected") fail(`deleted comment should be status=rejected, got ${del.body.status}`);
    const delMeta = parseMetaField(del.body).deleted as { by?: string; at?: string } | undefined;
    if (!delMeta || delMeta.by !== "human-mod" || !delMeta.at) fail(`deleted comment should carry meta.deleted={by:"human-mod",at}, got ${JSON.stringify(delMeta)}`);
    ok(`delete — cA #${cAId} soft-deleted (status=rejected, meta.deleted by=${delMeta.by})`);

    // --- assert: gone from the normal thread, but cB stays (targeted). ---
    const after = await getTicket(tokHuman, ticketId, { full: "1" });
    if (commentIds(after).includes(cAId)) fail(`deleted cA #${cAId} should be absent from the normal thread, got ${JSON.stringify(commentIds(after))}`);
    if (!commentIds(after).includes(cBId)) fail(`cB #${cBId} should still be present (delete is targeted), got ${JSON.stringify(commentIds(after))}`);
    ok("excluded — cA gone from the normal thread, cB intact");

    // --- assert: comment_count drops to 1. ---
    const countAfter = (await getTicket(tokHuman, ticketId)).comment_count as number;
    if (countAfter !== 1) fail(`comment_count should drop to 1 after delete, got ${countAfter}`);
    ok("excluded — comment_count 2 → 1 (tombstone not counted)");

    // --- assert: the ping was wiped (excluded from counts/gates). ---
    const unreadAfter = (((await unread(tokHuman, "human-mod", project)).messages as Array<{ id?: number }>) ?? []).map((m) => m.id);
    if (unreadAfter.includes(cAId)) fail(`cA's ping should be wiped after delete, still in unread=${JSON.stringify(unreadAfter)}`);
    ok("excluded — cA's ping wiped from the subscriber's unread");

    // --- assert: include_deleted=1 re-surfaces cA as a body-stripped tombstone. ---
    const tomb = await getTicket(tokHuman, ticketId, { full: "1", include_deleted: "1" });
    const cAtomb = ((tomb.comments as Array<Record<string, unknown>>) ?? []).find((c) => c.id === cAId);
    if (!cAtomb) fail(`include_deleted=1 should re-surface cA #${cAId} as a tombstone, got ids=${JSON.stringify(commentIds(tomb))}`);
    if (cAtomb.body !== null) fail(`tombstone should have body stripped to null, got ${JSON.stringify(cAtomb.body)}`);
    const tombMeta = parseMetaField(cAtomb).deleted as { by?: string } | undefined;
    if (!tombMeta || tombMeta.by !== "human-mod") fail(`tombstone should keep meta.deleted={by:"human-mod"}, got ${JSON.stringify(tombMeta)}`);
    ok("tombstone — include_deleted=1 re-surfaces cA with body=null + meta.deleted (UI placeholder)");

    ok("delete comment — soft-delete + tombstone, human-only, excluded from thread/count/pings (#328 q:42e8c9)");
    process.exit(0);
}

main().catch((e) => {
    console.error("scenario error:", e);
    process.exit(1);
});
