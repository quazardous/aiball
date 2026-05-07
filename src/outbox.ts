import { appendFileSync } from "node:fs";
import { outboxPath, ensureDirs } from "./paths.js";
import type { Message } from "./db.js";

/**
 * Append an approved message to its project's outbox JSONL file.
 * This is what subscribed agents tail via Monitor.
 *
 * The line emitted is a normalized "delivered" form: edited fields override
 * original ones, and only the fields that matter to a consumer are kept.
 */
export function deliverToOutbox(msg: Message): void {
    if (msg.status !== "approved") {
        throw new Error(`refusing to deliver non-approved message ${msg.id}`);
    }
    ensureDirs();
    // thread_id is the ticket_id for comments/closes; for ticket_created
    // it is the message's own id (the thread root).
    const thread_id =
        msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    const line = JSON.stringify({
        id: msg.id,
        project: msg.project,
        kind: msg.kind,
        thread_id,
        ticket_id: msg.ticket_id,
        parent_id: msg.parent_id,
        title: msg.edited_title ?? msg.title,
        body: msg.edited_body ?? msg.body,
        by_agent: msg.by_agent,
        human_note: msg.human_note,
        delivered_at: new Date().toISOString(),
        created_at: msg.created_at,
        decided_by: msg.decided_by,
    });
    appendFileSync(outboxPath(msg.project), line + "\n", "utf8");
}
