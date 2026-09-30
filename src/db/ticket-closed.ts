/**
 * #2339 — which of these tickets are closed, in one read.
 *
 * There is NO `closed` column (#2112): closure is a lifecycle EVENT, and a
 * ticket can be closed and reopened any number of times, so the latest of
 * `ticket_closed` / `ticket_reopened` wins. Approved events only: a close still
 * awaiting moderation has not happened.
 *
 * One rule for every reader. The pending counter and the pending list each
 * folded it on their own, and only one of them did, which is how poll counted
 * 19 pending tickets and listed 29.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { parseMeta } from "../questions.js";
import { resolvesTicket } from "../ticket-transitions.js";

/**
 * #3383 — the same rule as a condition on a `tickets` query: the ticket's
 * latest approved lifecycle event is not a close. It lets a reader of the open
 * tickets leave the closed ones in the database instead of loading every row
 * (bodies included) to drop most of them.
 */
export function ticketIsOpenSql() {
    return sql`COALESCE((
        SELECT lc.kind FROM ${schema.messages} lc
        WHERE lc.ticket_id = ${schema.tickets.id}
          AND lc.status = 'approved'
          AND lc.kind IN ('ticket_closed', 'ticket_reopened')
        ORDER BY lc.id DESC LIMIT 1
    ), '') <> 'ticket_closed'`;
}

/**
 * #3383 — the closed tickets of a project (of the board without one), read
 * from the lifecycle events alone: three columns, no message body.
 */
export function closedTicketIdsOf(project?: string): Set<number> {
    const rows = getDb()
        .select({ id: schema.messages.id, ticketId: schema.messages.ticketId, kind: schema.messages.kind })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
            project ? eq(schema.tickets.project, project) : undefined,
        ))
        .orderBy(schema.messages.id)
        .all();
    const closed = new Set<number>();
    for (const ev of rows) {
        if (ev.ticketId == null) continue;
        if (ev.kind === "ticket_closed") closed.add(ev.ticketId);
        else closed.delete(ev.ticketId);
    }
    return closed;
}

export function closedTicketIds(ticketIds: readonly number[]): Set<number> {
    const closed = new Set<number>();
    if (ticketIds.length === 0) return closed;
    const lifecycle = getDb()
        .select({ id: schema.messages.id, ticketId: schema.messages.ticketId, kind: schema.messages.kind })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.ticketId, [...ticketIds]),
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const lastClose = new Map<number, number>();
    const lastReopen = new Map<number, number>();
    for (const ev of lifecycle) {
        if (ev.ticketId == null) continue;
        const latest = ev.kind === "ticket_closed" ? lastClose : lastReopen;
        if (ev.id > (latest.get(ev.ticketId) ?? 0)) latest.set(ev.ticketId, ev.id);
    }
    for (const [ticketId, closeId] of lastClose) {
        if (closeId > (lastReopen.get(ticketId) ?? 0)) closed.add(ticketId);
    }
    return closed;
}

/** An event of a ticket, as the replay reads it (a Message is one). */
export interface LifecycleEvent {
    id: number;
    kind: string;
    status: string;
    by_agent: string | null;
    created_at: string;
    meta?: string | null;
}

/** A ticket's state from its events: closed, resolved, blocked, and who and when for the last two. */
export interface LifecycleState {
    closed: boolean;
    resolved: boolean;
    resolved_by: string | null;
    resolved_at: string | null;
    blocked: boolean;
    blocked_by: string | null;
    blocked_at: string | null;
}

/**
 * #3251 — the one replay of a ticket's lifecycle: approved events only, in id
 * order. A close closes; a reopen clears closed, resolved and blocked; a
 * resolution (the legacy `ticket_resolved`, or a comment whose decision was
 * accepted and resolves the ticket — dated by its decision) resolves; a block
 * blocks. Resolved and blocked outlive a close. `ticket.get` and the inbox
 * used to replay it apart, and dated a resolution differently.
 */
export function replayLifecycle(events: readonly LifecycleEvent[]): LifecycleState {
    const s: LifecycleState = { closed: false, resolved: false, resolved_by: null, resolved_at: null, blocked: false, blocked_by: null, blocked_at: null };
    const steps: { id: number; kind: string; by: string | null; at: string }[] = [];
    for (const m of events) {
        if (m.status !== "approved") continue;
        if (m.kind === "comment_added") {
            const d = parseMeta(m.meta ?? null).decision;
            if (d && resolvesTicket(d.kind, d.status)) steps.push({ id: m.id, kind: "ticket_resolved", by: d.decided_by ?? m.by_agent, at: d.decided_at ?? m.created_at });
            continue;
        }
        if (m.kind === "ticket_closed" || m.kind === "ticket_reopened" || m.kind === "ticket_resolved" || m.kind === "ticket_blocked") {
            steps.push({ id: m.id, kind: m.kind, by: m.by_agent, at: m.created_at });
        }
    }
    steps.sort((a, b) => a.id - b.id);
    for (const e of steps) {
        if (e.kind === "ticket_closed") s.closed = true;
        else if (e.kind === "ticket_reopened") Object.assign(s, { closed: false, resolved: false, resolved_by: null, resolved_at: null, blocked: false, blocked_by: null, blocked_at: null });
        else if (e.kind === "ticket_resolved") Object.assign(s, { resolved: true, resolved_by: e.by, resolved_at: e.at });
        else if (e.kind === "ticket_blocked") Object.assign(s, { blocked: true, blocked_by: e.by, blocked_at: e.at });
    }
    return s;
}

/**
 * #3251 — the thread's latest decision, whatever its status: the one the gate
 * reads and the composer's buttons sit under. The ticket's own (a
 * `ticket_new({ then: "plan" })`) once the ticket is approved, and each
 * approved comment's; the highest id wins. The web replayed the thread for it.
 */
export function latestDecision(
    ticket: { id: number; status: string; meta?: string | null },
    thread: readonly LifecycleEvent[],
): { message_id: number; kind: string; status: string } | null {
    let latest: { message_id: number; kind: string; status: string } | null = null;
    const consider = (id: number, meta: string | null | undefined) => {
        const d = parseMeta(meta ?? null).decision;
        if (d?.kind && d.status && (!latest || id > latest.message_id)) latest = { message_id: id, kind: d.kind, status: d.status };
    };
    if (ticket.status === "approved") consider(ticket.id, ticket.meta);
    for (const m of thread) if (m.kind === "comment_added" && m.status === "approved") consider(m.id, m.meta);
    return latest;
}
