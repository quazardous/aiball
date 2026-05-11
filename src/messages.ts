import {
    getMessage,
    insertMessage,
    insertRelationEvent,
    updateMessageStatus,
    insertPing,
    listTicketSubscribers,
    listProjectSubscribers,
    upsertTicketSubscription,
    listPendingResolvedForTicket,
    listPendingLifecycleForTicket,
    isTicketBroadcast,
    deletePingsForMessage,
    INTENTS,
    type Message,
    type NewMessage,
    type MessageKind,
    type Intent,
} from "./db.js";
import { evaluate } from "./rules.js";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";

export const VALID_KINDS: MessageKind[] = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
    "ticket_reopened",
    "ticket_resolved",
];

export interface ValidationError {
    error: string;
}

export function validateNewMessage(input: unknown): ValidationError | NewMessage {
    if (!input || typeof input !== "object") return { error: "body must be object" };
    const o = input as Record<string, unknown>;
    if (typeof o.project !== "string" || !o.project) {
        return { error: "project required" };
    }
    if (typeof o.kind !== "string" || !VALID_KINDS.includes(o.kind as MessageKind)) {
        return { error: `kind must be one of ${VALID_KINDS.join(", ")}` };
    }
    const kind = o.kind as MessageKind;
    if (kind !== "ticket_created") {
        if (typeof o.ticket_id !== "number" || !o.ticket_id) {
            return { error: `ticket_id required for kind=${kind}` };
        }
    }
    if (kind === "ticket_created" && (typeof o.title !== "string" || !o.title)) {
        return { error: "title required for ticket_created" };
    }
    let intent: Intent | null = null;
    if (o.intent !== undefined && o.intent !== null) {
        if (typeof o.intent !== "string" || !INTENTS.includes(o.intent as Intent)) {
            return { error: `intent must be one of ${INTENTS.join(", ")}` };
        }
        intent = o.intent as Intent;
    }
    return {
        project: o.project,
        kind,
        ticket_id: typeof o.ticket_id === "number" ? o.ticket_id : null,
        parent_id: typeof o.parent_id === "number" ? o.parent_id : null,
        title: typeof o.title === "string" ? o.title : null,
        body: typeof o.body === "string" ? o.body : null,
        by_agent: typeof o.by_agent === "string" ? o.by_agent : null,
        intent: kind === "ticket_created" ? intent : null,
    };
}

/**
 * Auto-subscribe the message author to its parent ticket. Called for every
 * inserted message regardless of moderation outcome — even if the message
 * itself is rejected later, the author has shown intent to follow the
 * thread. No-ops if by_agent is unset (anonymous post).
 */
function autoSubscribeAuthor(msg: Message): void {
    if (!msg.by_agent) return;
    const ticketId = msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (!ticketId) return;
    upsertTicketSubscription(msg.by_agent, ticketId);
}

/**
 * Fan out delivery rows (in the `pings` table) for every recipient that
 * should learn about this newly-approved message. Recipients are the union
 * of:
 *   - ticket subscribers (people following the thread directly — they always
 *     get pings on threads they explicitly follow, regardless of broadcast).
 *   - project owners (subscriptions.role = "owner" — agents that maintain
 *     this project, they want to see every movement, internal or not).
 *   - project followers (subscriptions.role = "follower"), but only when
 *     the parent ticket has its `broadcast` flag set to 1. This keeps
 *     internal dev chatter out of external agents' inboxes while still
 *     letting public/API-impacting tickets reach them.
 * minus the message author themself (no self-ping).
 *
 * Each ping row is per-recipient with its own `seen_at`, so consumption is
 * independent across consumers. Called only when a message becomes approved.
 *
 * This is the SOLE delivery mechanism — there is no cursor model anywhere.
 * Pending-then-approved messages always reach every interested consumer
 * because the fan-out runs at approval time, not at submission.
 */
export function fanOutPings(msg: Message): void {
    const recipients = new Set<string>();

    const ticketId = msg.kind === "ticket_created"
        ? msg.id
        : msg.ticket_id;

    // Ticket subscribers: explicit thread follow always wins regardless of
    // broadcast state. Skip on ticket_created since there's no thread yet
    // (the creator is auto-subbed to their own ticket and self-filtered).
    if (msg.kind !== "ticket_created" && msg.ticket_id !== null) {
        for (const sub of listTicketSubscribers(msg.ticket_id)) {
            recipients.add(sub);
        }
    }

    // Project owners always see everything in their project.
    for (const sub of listProjectSubscribers(msg.project, { roles: ["owner"] })) {
        recipients.add(sub);
    }

    // Project followers only see broadcast-flagged tickets. We resolve the
    // flag on the parent ticket — for ticket_created msg.id IS the ticket;
    // for comments/lifecycle we look up via msg.ticket_id.
    if (ticketId !== null && isTicketBroadcast(ticketId)) {
        for (const sub of listProjectSubscribers(msg.project, { roles: ["follower"] })) {
            recipients.add(sub);
        }
    }

    // Pending messages also ping the configured human moderator (default
    // "human", overridable via AIBALL_HUMAN) so they show up as unread in
    // the moderation queue even when the moderator isn't subscribed to
    // the project. Approved messages don't need this — the regular
    // subscriber fan-out already covers what the human cares about.
    if (msg.status === "pending") {
        recipients.add(process.env.AIBALL_HUMAN ?? "human");
    }

    for (const r of recipients) {
        if (r === msg.by_agent) continue;
        insertPing(r, msg);
    }
}

/**
 * Lifecycle events authored by the ticket's original creator (close /
 * reopen / resolved) skip moderation — the author already had authority
 * over the thread. Other agents posting these events still go through the
 * rule engine (rules + strategy + human bypass).
 *
 * Note: ticket_resolved is intentionally a "soft" signal that anyone can
 * propose — when posted by a non-owner, it goes through review and shows
 * up as a proposal in the UI. The reporter validates by closing.
 */
function isOwnerLifecycleEvent(input: NewMessage): boolean {
    if (
        input.kind !== "ticket_closed" &&
        input.kind !== "ticket_reopened" &&
        input.kind !== "ticket_resolved"
    ) {
        return false;
    }
    if (!input.by_agent || !input.ticket_id) return false;
    const parent = getMessage(input.ticket_id);
    return (
        parent?.kind === "ticket_created" &&
        parent.by_agent === input.by_agent
    );
}

/**
 * Hard rule: only the ticket reporter (the agent who opened the thread) can
 * close it. Anyone else who wants to signal "I think this is done" should
 * post `ticket_resolved` (a soft proposal) — the reporter still validates
 * by closing.
 *
 * This is enforced before the message is even inserted, so the database
 * never holds a stray ticket_closed from a non-owner. Throws with a marker
 * the HTTP layer maps to 403.
 */
function assertCloseAuthority(input: NewMessage): void {
    if (input.kind !== "ticket_closed") return;
    if (!input.ticket_id) return;
    const parent = getMessage(input.ticket_id);
    if (!parent || parent.kind !== "ticket_created") return;
    if (input.by_agent && input.by_agent === parent.by_agent) return;
    // Human moderator bypass: the configured human (default "human",
    // overridable via AIBALL_HUMAN) can always close any ticket from the
    // UI — they are the override authority on every project. The strict
    // reporter-only rule still applies to agents posting via MCP/CLI.
    const human = process.env.AIBALL_HUMAN ?? "human";
    if (input.by_agent === human) return;
    const err = new Error(
        `only the ticket reporter (${parent.by_agent ?? "unknown"}) can close this ticket — post ticket_resolved instead to propose resolution`,
    );
    (err as Error & { code?: string }).code = "FORBIDDEN_CLOSE";
    throw err;
}

/**
 * Extract every `#NN` / `#B.NN` / `#BNN` ticket reference from a body,
 * **outside** of code fences and inline-backtick spans (so `#123` inside
 * a code block stays inert, per #B.62). Returns unique numeric refs.
 *
 * `selfTicketId` is excluded so a body that mentions its own ticket
 * (e.g. "see also #B.42") doesn't trigger a self-referenced event.
 */
function extractTicketRefs(
    body: string | null | undefined,
    selfTicketId: number,
): number[] {
    if (!body) return [];
    // Strip code fences (triple-backtick) and inline-backtick spans so
    // refs inside them don't get linkified into events.
    const stripped = body
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
    const refs = new Set<number>();
    // Accept #123, #B123, #B.123. Boundary on the left: start of input,
    // whitespace, or punctuation that's NOT word/slash (so a URL like
    // /foo#3 doesn't match). Boundary on the right: \b.
    const re = /(?:^|[^\w/])#B?\.?(\d+)\b/g;
    for (const m of stripped.matchAll(re)) {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (n === selfTicketId) continue;
        refs.add(n);
    }
    return [...refs];
}

/**
 * Auto-emit cross-reference pseudo-comments triggered by a freshly
 * inserted message:
 *   - `ticket_sub_added` on parent thread when the message is a
 *     ticket_created with a parent_ticket_id.
 *   - `ticket_referenced` on each ticket mentioned in the message body.
 *
 * Each pseudo-comment is also fanned out + broadcast like a normal
 * message so subscribers to the target thread receive a ping (per
 * #B.61 follow-up + #B.62).
 */
function postRelationEvents(msg: Message, input: NewMessage): void {
    // Source ticket = the ticket the relation originates from. For a
    // ticket_created, the source IS the new ticket (its id). For a
    // comment_added, the source is the comment's parent thread.
    const sourceTicketId =
        msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (sourceTicketId === null) return;

    // 1. Sub-ticket lineage.
    if (msg.kind === "ticket_created" && input.parent_id) {
        const parent = getMessage(input.parent_id);
        if (parent && parent.kind === "ticket_created") {
            const pseudo = insertRelationEvent({
                target_ticket_id: parent.id,
                source_ticket_id: msg.id,
                kind: "ticket_sub_added",
                by_agent: msg.by_agent,
            });
            if (pseudo) {
                fanOutPings(pseudo);
                broadcast({ type: "message_created", data: pseudo });
            }
        }
    }

    // 2. Body cross-references (#B.NN in body, outside backticks).
    const refs = extractTicketRefs(msg.body, sourceTicketId);
    for (const refId of refs) {
        const target = getMessage(refId);
        if (!target || target.kind !== "ticket_created") continue;
        const pseudo = insertRelationEvent({
            target_ticket_id: target.id,
            source_ticket_id: sourceTicketId,
            kind: "ticket_referenced",
            by_agent: msg.by_agent,
        });
        if (pseudo) {
            fanOutPings(pseudo);
            broadcast({ type: "message_created", data: pseudo });
        }
    }
}

/**
 * Single source of truth for "a new message arrived" — used by both the HTTP
 * API and the spool drainer so behavior is identical regardless of channel.
 */
export function submitMessage(input: NewMessage): Message {
    assertCloseAuthority(input);
    let msg = insertMessage(input);
    autoSubscribeAuthor(msg);
    // Fan out delivery pings at INSERTION (not just at approval): subscribers
    // need to know "new activity landed on my ticket" even before the
    // moderator decides. `insertPing` is idempotent (onConflictDoNothing on
    // the (recipient, message_id) primary key), so the later approval-time
    // fan-out is a safe no-op. Pings on rejected messages are cleaned up by
    // the moderation handler (api.ts decide()).
    fanOutPings(msg);
    // Always announce the message: every UI list (pending, approved, tickets,
    // open thread) wants to know that a new row exists, regardless of how
    // moderation will resolve it.
    broadcast({ type: "message_created", data: msg });

    // Cross-reference pseudo-comments (`ticket_sub_added` + `ticket_referenced`)
    // — auto-emitted on the target threads. Side-effect only; the
    // returned msg refers to the original message. Run at insertion so
    // the pseudo-comments land in the thread even if moderation is
    // still pending; rejection cleanup is a future iteration if needed.
    if (msg.kind === "ticket_created" || msg.kind === "comment_added") {
        postRelationEvents(msg, input);
    }

    const ownerLifecycle = isOwnerLifecycleEvent(input);
    const decision = ownerLifecycle
        ? { decision: "auto" as const, matched_rule_id: null }
        : evaluate({
            project: input.project,
            kind: input.kind,
            by_agent: input.by_agent ?? null,
        });
    if (decision.decision === "auto") {
        const updated = updateMessageStatus(
            msg.id,
            "approved",
            ownerLifecycle ? "owner" : "auto",
            decision.matched_rule_id,
        );
        if (updated) {
            msg = updated;
            deliverToOutbox(msg);
            fanOutPings(msg);
            // …and announce the auto-approval so subscribers transition state
            // (status: pending → approved) without polling.
            broadcast({ type: "message_decided", data: msg });
            // Closing a ticket is the canonical "yes, this is done" — any
            // dangling `ticket_resolved` proposals on this ticket are no
            // longer awaiting moderation, the close just validated them.
            // Auto-approve them so the inbox / UI stop surfacing stale
            // pending state.
            if (msg.kind === "ticket_closed" && msg.ticket_id !== null) {
                // Pending ticket_resolved on this ticket → auto-approve
                // (closing implies acceptance of the resolution proposal).
                for (const stale of listPendingResolvedForTicket(msg.ticket_id)) {
                    const promoted = updateMessageStatus(
                        stale.id,
                        "approved",
                        "owner",
                        null,
                    );
                    if (promoted) {
                        deliverToOutbox(promoted);
                        fanOutPings(promoted);
                        broadcast({ type: "message_decided", data: promoted });
                    }
                }
                // Pending ticket_closed / ticket_reopened on this ticket are
                // moot once a close lands → auto-reject them so they stop
                // polluting the moderation queue. Their pings get wiped too.
                for (const stale of listPendingLifecycleForTicket(
                    msg.ticket_id,
                    ["ticket_closed", "ticket_reopened"],
                    msg.id, // don't reject the close we just approved
                )) {
                    const rejected = updateMessageStatus(
                        stale.id,
                        "rejected",
                        "owner",
                        null,
                    );
                    if (rejected) {
                        deletePingsForMessage(stale.id);
                        broadcast({ type: "message_decided", data: rejected });
                    }
                }
            }
        }
    }
    return msg;
}
