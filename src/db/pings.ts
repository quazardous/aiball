/**
 * Pings — the per-recipient delivery table. After migration 0007 the
 * polymorphic `pings.message_id` was split into two mutually exclusive
 * columns:
 *   - `pings.ticket_id`  → set when the ping points at a ticket root.
 *   - `pings.comment_id` → set when the ping points at a comment / lifecycle.
 *
 * Exactly one is non-NULL per row (CHECK enforced).
 *
 * Because the migration ALSO ensured that `tickets.id` and `_messages.id`
 * never overlap (messages are shifted by +1_000_000), callers can keep
 * passing a plain integer `id` to most read/seen helpers — the helpers
 * test both columns with OR; at most one matches.
 *
 * For inserts the caller must say which kind it is (we wrap that in
 * `insertPing(recipient, msg)` where msg.kind decides the column).
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { emitPing } from "../event-bus.js";
import {
    getDb,
    nowIso,
    ticketRowToMessage,
    messageRowToMessage,
    type Message,
    type MessageKind,
} from "./connection.js";
import type { Intent } from "../domain.js";
import {
    buildBacklogRulesCtx,
    defaultBacklogRules,
    type RuleItem,
    type Target,
} from "./backlog-rules.js";

// =====================================================================
//  Helpers
// =====================================================================

/**
 * Returns a `WHERE pings.<col> = id` clause that matches whichever of the
 * two target columns the id belongs to. Convenient for the seen / delete
 * helpers that take a plain integer (the caller has lost the kind by then).
 */
function targetMatches(id: number) {
    return or(eq(schema.pings.ticketId, id), eq(schema.pings.commentId, id));
}

function targetInArray(ids: number[]) {
    return or(
        inArray(schema.pings.ticketId, ids),
        inArray(schema.pings.commentId, ids),
    );
}

/**
 * #886 — Toutes les rules "qu'est-ce qui est dans mon queue/count/feed"
 * vivent dans `backlog-rules.ts`. Les 4 helpers ci-dessous (listUnread /
 * unreadCount / listPings / unreadPingCount) délèguent au moteur — chacun
 * en passant le `Target` qui matche sa surface logique.
 */
function ticketRowToRuleItem(t: { id: number; byAgent: string | null; assignee: string | null }): RuleItem {
    return {
        ticketId: t.id,
        ticketByAgent: t.byAgent,
        assignee: t.assignee,
    };
}
function messageRowToRuleItem(
    m: { byAgent: string | null; kind: string },
    parent: { id: number; byAgent: string | null; assignee: string | null },
): RuleItem {
    return {
        ticketId: parent.id,
        ticketByAgent: parent.byAgent,
        commentByAgent: m.byAgent,
        commentKind: m.kind,
        assignee: parent.assignee,
    };
}

// =====================================================================
//  Write side
// =====================================================================

/**
 * Insert a ping. The caller passes the Message itself (or just enough of
 * one) so we can route the row to the right column based on `kind`.
 *
 * The shape `{ id, kind }` is loose on purpose — most callers have a full
 * `Message` in hand from the fan-out path, but the moderation transition
 * ping in api.ts only needs id + kind.
 */
export function insertPing(
    recipient: string,
    msg: {
        id: number;
        kind: MessageKind;
        // Comment-only fields — used to enrich the emitted PingEvent so
        // SSE consumers (notably claude-loop's wake-phrase builder) can
        // reference the comment by its public hashid and name the parent
        // ticket, instead of leaking the numeric `_messages.id`.
        hashid?: string | null;
        ticket_id?: number | null;
        // Ticket-only: msg.intent is the ticket's own intent. For comment
        // pings the comment row's intent is almost always null, so we
        // look the parent ticket's intent up below — agents care about
        // the THREAD's urgency, not the comment's.
        intent?: Intent | null;
    },
    /** #296: who caused this ping — the post author for fan-out, the decider
     *  for a decision/moderation notification. Drives the self-ping filter
     *  (`actor == recipient` ⇒ hidden). Null when unknown (legacy/unset). */
    actor?: string | null,
): void {
    const isTicket = msg.kind === "ticket_created";
    const db = getDb();
    const r = db.insert(schema.pings).values({
        recipient,
        ticketId: isTicket ? msg.id : null,
        commentId: isTicket ? null : msg.id,
        actor: actor ?? null,
        createdAt: nowIso(),
    }).onConflictDoNothing().run();
    // Only emit when the row was actually inserted (onConflictDoNothing
    // can swallow a duplicate). Subscribers (SSE) react in real-time —
    // no more polling-lag (#B.148 phase A).
    if (r.changes > 0) {
        // #B.214 david: a `ticket_closed` / `ticket_referenced` /
        // `ticket_sub_added` / `ticket_resolved` event on a panic
        // ticket used to inherit the parent's intent, so closing a
        // panic re-fired the mid-turn interrupt (claude-loop sees
        // `intent: panic` and runs tryPanic). Only the kinds that
        // carry actual user-authored content (the original post and
        // its comments) propagate intent — lifecycle events stay
        // intent-less so the wake-phrase builder defaults to a plain
        // wake and panic interrupt is never triggered by a close.
        const propagateIntent = msg.kind === "ticket_created" || msg.kind === "comment_added";
        let intent: Intent | undefined;
        if (propagateIntent) {
            if (isTicket) {
                intent = (msg.intent ?? undefined) as Intent | undefined;
            } else if (msg.ticket_id) {
                // Comment ping: pull the parent ticket's intent so
                // the wake phrase can scale directiveness. One tiny
                // indexed lookup per actual new ping — fine.
                const t = db.select({ intent: schema.tickets.intent })
                    .from(schema.tickets)
                    .where(eq(schema.tickets.id, msg.ticket_id))
                    .get();
                intent = (t?.intent ?? undefined) as Intent | undefined;
            }
        }
        emitPing(recipient, {
            ticket_id: isTicket ? msg.id : (msg.ticket_id ?? undefined),
            comment_id: isTicket ? undefined : msg.id,
            comment_hashid: isTicket ? undefined : (msg.hashid ?? undefined),
            intent,
        });
    }
}

/**
 * Wipe every ping row that points at this message id (whichever column).
 * Used when a message is rejected: the at-insertion fan-out had already
 * pinged subscribers, but the message will never be approved so it
 * should not keep surfacing as unread in their inboxes.
 */
export function deletePingsForMessage(messageId: number): { deleted: number } {
    const r = getDb().delete(schema.pings)
        .where(targetMatches(messageId))
        .run();
    return { deleted: r.changes };
}

export function markMessageSeen(
    consumer_id: string,
    message_id: number,
): { updated: number } {
    const r = getDb().update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            targetMatches(message_id),
            isNull(schema.pings.seenAt),
        )).run();
    return { updated: r.changes };
}

/**
 * #827 — resurface a message : clear `seen_at` on EVERY ping row pointing
 * at this message, regardless of recipient. The human-driven UI button
 * uses this to re-queue a message the recipients drained-but-didn't-act
 * on, so the next wake re-surfaces it. Returns the count of pings cleared.
 *
 * Distinct from `markMessageSeen` (which is the consumer's own ack-side
 * mutation, per-recipient) : `clearSeenForMessage` is fan-out wide and
 * is gated to humans at the route layer (a normal agent posting from
 * MCP can't fabricate it).
 */
export function clearSeenForMessage(message_id: number): { resurfaced: number } {
    const r = getDb().update(schema.pings)
        .set({ seenAt: null })
        .where(and(
            targetMatches(message_id),
            // Only flip rows that were ack'd ; an already-unread ping
            // doesn't count as a re-surface (would inflate the metric).
            sql`${schema.pings.seenAt} IS NOT NULL`,
        )).run();
    return { resurfaced: r.changes };
}

/**
 * #1185 — operator prune of a consumer's ping backlog. Mark-seen (default) or
 * hard-DELETE the pings, optionally scoped to one project (default: all the
 * consumer's pings, every project). The cross-consumer / cross-project reach is
 * gated to local (UDS) trust at the API layer — this is a deliberate operator
 * action, NOT the agent-side ack the MCP intentionally dropped in #826.
 */
export function prunePings(
    consumer_id: string,
    opts: { project?: string; del?: boolean } = {},
): { affected: number } {
    const db = getDb();
    // Project scope → the id set of that project's tickets + their messages.
    let scope = undefined as ReturnType<typeof targetInArray> | undefined;
    if (opts.project) {
        const ticketIds = db.select({ id: schema.tickets.id })
            .from(schema.tickets).where(eq(schema.tickets.project, opts.project))
            .all().map((r) => r.id);
        const messageIds = ticketIds.length
            ? db.select({ id: schema.messages.id }).from(schema.messages)
                .where(inArray(schema.messages.ticketId, ticketIds)).all().map((r) => r.id)
            : [];
        const allIds = [...ticketIds, ...messageIds];
        if (!allIds.length) return { affected: 0 };
        scope = targetInArray(allIds);
    }
    if (opts.del) {
        // Hard-delete every ping row (seen or not) for the consumer in scope.
        const r = db.delete(schema.pings)
            .where(and(eq(schema.pings.recipient, consumer_id), scope))
            .run();
        return { affected: r.changes };
    }
    // Mark-seen only the still-unseen rows (seen ones are already drained).
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(eq(schema.pings.recipient, consumer_id), isNull(schema.pings.seenAt), scope))
        .run();
    return { affected: r.changes };
}

export function markAllSeenForProject(
    consumer_id: string,
    project: string,
): { updated: number } {
    const db = getDb();
    const ticketIds = db.select({ id: schema.tickets.id })
        .from(schema.tickets).where(eq(schema.tickets.project, project)).all().map((r) => r.id);
    const messageIds = ticketIds.length
        ? db.select({ id: schema.messages.id }).from(schema.messages)
            .where(inArray(schema.messages.ticketId, ticketIds)).all().map((r) => r.id)
        : [];
    const allIds = [...ticketIds, ...messageIds];
    if (!allIds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            targetInArray(allIds),
        )).run();
    return { updated: r.changes };
}

/**
 * Mark every ping the consumer has on this ticket (and on every comment of
 * the thread) as seen. Used by the UI auto-mark-read on the thread detail
 * view (per #B91) and by the explicit "mark read" toggle in the list row
 * (#C92). Idempotent — pings already seen are left alone.
 */
export function markTicketSeen(
    consumer_id: string,
    ticket_id: number,
    opts?: { upTo?: number },
): { updated: number } {
    // `upTo` (#B.191) bounds the ack — only pings whose target message
    // id is <= upTo are flipped to seen. Used by the ThreadView dwell
    // timer so comments arriving AFTER the user opened the thread keep
    // their unseen ping (row stays bold+green in the inbox).
    const db = getDb();
    const upTo = opts?.upTo;
    const commentConds = [eq(schema.messages.ticketId, ticket_id)];
    if (typeof upTo === "number") commentConds.push(lte(schema.messages.id, upTo));
    const commentIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(...commentConds))
        .all()
        .map((r) => r.id);
    const targetConds = [];
    if (typeof upTo !== "number" || ticket_id <= upTo) {
        targetConds.push(eq(schema.pings.ticketId, ticket_id));
    }
    if (commentIds.length) targetConds.push(inArray(schema.pings.commentId, commentIds));
    if (!targetConds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            or(...targetConds),
        )).run();
    return { updated: r.changes };
}

/**
 * Inverse of markTicketSeen: clear the seen_at on every ping the consumer
 * has on this ticket and its comments. Used by the explicit "mark unread"
 * toggle in the list row (#C92) so the thread re-surfaces in unread filters.
 */
export function markTicketUnseen(
    consumer_id: string,
    ticket_id: number,
): { updated: number } {
    const db = getDb();
    const commentIds = db.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, ticket_id))
        .all()
        .map((r) => r.id);
    const conds = [eq(schema.pings.ticketId, ticket_id)];
    if (commentIds.length) conds.push(inArray(schema.pings.commentId, commentIds));
    const r = db.update(schema.pings)
        .set({ seenAt: null })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNotNull(schema.pings.seenAt),
            or(...conds),
        )).run();
    return { updated: r.changes };
}

export function markSeenUpToForProject(
    consumer_id: string,
    project: string,
    upToId: number,
): { updated: number } {
    const db = getDb();
    const ticketIds = db.select({ id: schema.tickets.id })
        .from(schema.tickets).where(eq(schema.tickets.project, project)).all().map((r) => r.id);
    const messageIds = ticketIds.length
        ? db.select({ id: schema.messages.id }).from(schema.messages)
            .where(inArray(schema.messages.ticketId, ticketIds)).all().map((r) => r.id)
        : [];
    const allIds = [...ticketIds, ...messageIds].filter((id) => id <= upToId);
    if (!allIds.length) return { updated: 0 };
    const r = db.update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            targetInArray(allIds),
        )).run();
    return { updated: r.changes };
}

export function markPingsRead(opts: {
    recipient: string;
    upToId?: number;
    all?: boolean;
}): { updated: number } {
    if (!opts.upToId && !opts.all) return { updated: 0 };
    const conds = [
        eq(schema.pings.recipient, opts.recipient),
        isNull(schema.pings.seenAt),
    ];
    if (opts.upToId) {
        // `upToId` is a cursor over the combined id space — match
        // whichever target column is set, gated by ≤ cursor.
        conds.push(
            or(
                and(isNotNull(schema.pings.ticketId), lte(schema.pings.ticketId, opts.upToId)),
                and(isNotNull(schema.pings.commentId), lte(schema.pings.commentId, opts.upToId)),
            )!,
        );
    }
    const r = getDb().update(schema.pings)
        .set({ seenAt: nowIso() })
        .where(and(...conds))
        .run();
    return { updated: r.changes };
}

// =====================================================================
//  Read side
// =====================================================================

/**
 * Self-pings (where the underlying message's by_agent matches the ping's
 * recipient) are filtered out. They land in the table by way of transition
 * pings — when a moderator decides on a pending post, the daemon inserts a
 * ping for the author so the agent could in theory poll for "my own status
 * changed". But surfacing those in the same `unread()` feed as activity
 * pings clutters the inbox: the agent already knows what they posted. Data
 * is preserved in the table; just hidden from the user-facing query.
 */
/**
 * #1163 Slice 1 — latest approved `meta.summary_until` per ticket (the
 * pivot line brief-reads anchor on). One grouped query ; used to enrich
 * the notification surfaces so agents can triage a ping without a
 * ticket_get round-trip.
 */
export function latestSummaryUntilByTicket(ticketIds: number[]): Map<number, string> {
    const out = new Map<number, string>();
    const ids = [...new Set(ticketIds.filter((id) => Number.isFinite(id)))];
    if (ids.length === 0) return out;
    const rows = getDb().all<{ ticket_id: number; su: string }>(sql`
        SELECT ticket_id, json_extract(meta, '$.summary_until') AS su
        FROM _messages m
        WHERE ticket_id IN ${ids}
          AND status = 'approved'
          AND json_extract(meta, '$.summary_until') IS NOT NULL
          AND id = (
              SELECT MAX(m2.id) FROM _messages m2
              WHERE m2.ticket_id = m.ticket_id
                AND m2.status = 'approved'
                AND json_extract(m2.meta, '$.summary_until') IS NOT NULL
          )
    `);
    for (const r of rows) if (r.su) out.set(r.ticket_id, r.su);
    return out;
}

/** #1163 Slice 1 — attach `ticket_summary_until` to notification rows. */
function enrichWithTicketSummary(msgs: Message[]): Message[] {
    const ids = msgs.map((m) => m.ticket_id ?? (m.kind === "ticket_created" ? m.id : null))
        .filter((v): v is number => v !== null);
    const su = latestSummaryUntilByTicket(ids);
    for (const m of msgs) {
        const tid = m.ticket_id ?? (m.kind === "ticket_created" ? m.id : null);
        if (tid !== null && su.has(tid)) m.ticket_summary_until = su.get(tid);
    }
    return msgs;
}

export function listUnread(
    consumer_id: string,
    project: string | null | undefined,
    limit = 100,
    since?: string,
): Message[] {
    const msgs = fetchUnread(consumer_id, project, "unread-list").messages;
    const filtered = since ? msgs.filter((m) => m.created_at >= since) : msgs;
    return enrichWithTicketSummary(filtered.slice(0, limit));
}

/**
 * Count the tickets posted by `by_agent` that are still pending
 * moderation AND not currently closed. Used by the MCP `_status`
 * block so an author sees, in passing, whether their submissions
 * are still waiting on a moderator.
 *
 * #B.218: a pending ticket that was closed (e.g. agent created +
 * self-closed before approval, or moderator closed without
 * accepting) is no longer in the moderation queue — exclude it
 * to keep the count honest. Reopen restores it: a ticket is
 * "currently closed" iff the latest close event is more recent
 * than the latest reopen event for the same ticket.
 */
export function pendingTicketsByAuthor(by_agent: string): number {
    const db = getDb();
    const pendingRows = db.select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(and(
            eq(schema.tickets.byAgent, by_agent),
            eq(schema.tickets.status, "pending"),
        ))
        .all();
    if (pendingRows.length === 0) return 0;
    const pendingIds = pendingRows.map((r) => r.id);
    const lifecycle = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.ticketId, pendingIds),
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const lastClose = new Map<number, number>();
    const lastReopen = new Map<number, number>();
    for (const ev of lifecycle) {
        if (ev.ticket_id == null) continue;
        const map = ev.kind === "ticket_closed" ? lastClose : lastReopen;
        const prev = map.get(ev.ticket_id) ?? 0;
        if (ev.id > prev) map.set(ev.ticket_id, ev.id);
    }
    return pendingIds.filter((id) => {
        const c = lastClose.get(id) ?? 0;
        const r = lastReopen.get(id) ?? 0;
        return c <= r;
    }).length;
}

export function unreadCount(consumer_id: string, project: string | null | undefined): number {
    return fetchUnread(consumer_id, project, "unread-count").total;
}

/**
 * #886 — shared scan for the 2 read helpers above. One DB pass + one
 * pass through the rules engine. The caller picks the Target — same
 * fetch, different filter set.
 */
function fetchUnread(
    consumer_id: string,
    project: string | null | undefined,
    target: Target,
): { messages: Message[]; total: number } {
    const db = getDb();
    const projectFilter = project ?? null;
    // DB-level : recipient + unread. Everything else (self-author,
    // closed, snoozed, etc.) goes through BacklogRules.
    const ticketCond = projectFilter
        ? and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, projectFilter),
        )
        : and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
        );
    const ticketRows = db.select({ t: schema.tickets })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(ticketCond)
        .all();

    const messageCond = projectFilter
        ? and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            eq(schema.tickets.project, projectFilter),
        )
        : and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
        );
    const messageRows = db.select({
        m: schema.messages,
        project: schema.tickets.project,
        t: schema.tickets,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(messageCond)
        .all();

    const ctx = buildBacklogRulesCtx(consumer_id);
    const ticketKept = defaultBacklogRules.filter(
        ticketRows,
        (r) => ticketRowToRuleItem(r.t),
        ctx,
        target,
    );
    const messageKept = defaultBacklogRules.filter(
        messageRows,
        (r) => messageRowToRuleItem(r.m, r.t),
        ctx,
        target,
    );
    const merged: Message[] = [
        ...ticketKept.map((r) => ticketRowToMessage(r.t)),
        ...messageKept.map((r) => messageRowToMessage(r.m, r.project)),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    // #895 — sort par created_at (ISO string lexicographique = chrono),
    // pas par id : migration #0007 a partitionné les ID ranges (tickets
    // 1+, comments 1_000_000+) → un nouveau ticket (id petit) sortait
    // AVANT un comment ancien (id grand) dans la FIFO `wake CTA`.
    return { messages: merged, total: ticketKept.length + messageKept.length };
}

/**
 * For each ticket in `ticket_ids`, returns whether the consumer has at
 * least one unseen ping anywhere on its thread (the ticket itself or any
 * of its comments). Used by /api/inbox to surface the per-row unread flag
 * in a single batched query.
 */
export function ticketUnreadFlags(
    consumer_id: string,
    ticket_ids: number[],
): Map<number, boolean> {
    const out = new Map<number, boolean>();
    for (const id of ticket_ids) out.set(id, false);
    if (ticket_ids.length === 0) return out;
    const db = getDb();
    // Pings on the ticket roots (pings.ticket_id).
    const rootHits = db.select({
        ticket_id: schema.pings.ticketId,
    }).from(schema.pings).where(and(
        eq(schema.pings.recipient, consumer_id),
        isNull(schema.pings.seenAt),
        inArray(schema.pings.ticketId, ticket_ids),
        // #355: ne pas allumer le flag unread de la rangée sur sa propre
        // action. Aligne ticketUnreadFlags sur unreadCount / listUnread /
        // listPings, qui excluent tous le self-ping via la colonne actor
        // (legacy actor=null conservé). Sans ça, un self-ping (ex. #241,
        // agent sous by_agent override) allume la rangée mais pas le badge
        // sidebar ni le feed → "mon commentaire est unread pour moi-même".
        or(
            isNull(schema.pings.actor),
            ne(schema.pings.actor, consumer_id),
        ),
    )).all();
    for (const r of rootHits) if (r.ticket_id !== null) out.set(r.ticket_id, true);
    // Pings on comments → join _messages to map back to ticket_id.
    const commentHits = db.select({
        ticket_id: schema.messages.ticketId,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.pings.commentId, schema.messages.id))
        .where(and(
            eq(schema.pings.recipient, consumer_id),
            isNull(schema.pings.seenAt),
            inArray(schema.messages.ticketId, ticket_ids),
            // #355: même exclusion self-actor que rootHits ci-dessus.
            or(
                isNull(schema.pings.actor),
                ne(schema.pings.actor, consumer_id),
            ),
        ))
        .all();
    for (const r of commentHits) out.set(r.ticket_id, true);
    return out;
}

export interface Ping {
    recipient: string;
    message_id: number;
    created_at: string;
    seen_at: string | null;
    message: Message;
}

export function listPings(opts: {
    recipient: string;
    unreadOnly?: boolean;
    limit?: number;
}): Ping[] {
    const db = getDb();
    const baseCond = opts.unreadOnly
        ? and(eq(schema.pings.recipient, opts.recipient), isNull(schema.pings.seenAt))
        : eq(schema.pings.recipient, opts.recipient);

    const ticketRows = db.select({ ping: schema.pings, t: schema.tickets })
        .from(schema.pings)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
        .where(baseCond)
        .all();
    const messageRows = db.select({
        ping: schema.pings,
        m: schema.messages,
        project: schema.tickets.project,
        parent_intent: schema.tickets.intent,
        t: schema.tickets,
    })
        .from(schema.pings)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(baseCond)
        .all();

    const ctx = buildBacklogRulesCtx(opts.recipient);
    const ticketKept = defaultBacklogRules.filter(
        ticketRows,
        (r) => ticketRowToRuleItem(r.t),
        ctx,
        "unread-list",
    );
    const messageKept = defaultBacklogRules.filter(
        messageRows,
        (r) => messageRowToRuleItem(r.m, r.t),
        ctx,
        "unread-list",
    );

    // #B.214 david "a+c": panic-first, then chronological reverse.
    type Keyed = { ping: Ping; is_panic: boolean };
    const keyed: Keyed[] = [
        ...ticketKept.map((r) => ({
            ping: {
                recipient: r.ping.recipient,
                message_id: r.ping.ticketId!,
                created_at: r.ping.createdAt,
                seen_at: r.ping.seenAt,
                message: ticketRowToMessage(r.t),
            },
            is_panic: r.t.intent === "panic",
        })),
        ...messageKept.map((r) => ({
            ping: {
                recipient: r.ping.recipient,
                message_id: r.ping.commentId!,
                created_at: r.ping.createdAt,
                seen_at: r.ping.seenAt,
                message: messageRowToMessage(r.m, r.project),
            },
            is_panic: r.parent_intent === "panic",
        })),
    ];
    keyed.sort((a, b) => {
        if (a.is_panic !== b.is_panic) return a.is_panic ? -1 : 1;
        return b.ping.created_at.localeCompare(a.ping.created_at);
    });
    const out: Ping[] = keyed.map((k) => k.ping);
    const sliced = opts.limit ? out.slice(0, opts.limit) : out;
    // #1163 Slice 1 — same enrichment as listUnread : the parent ticket's
    // current pivot line rides the ping so the agent triages without a
    // ticket_get round-trip.
    enrichWithTicketSummary(sliced.map((p) => p.message));
    return sliced;
}

export function unreadPingCount(recipient: string): number {
    return fetchUnread(recipient, null, "unread-count").total;
}
