/**
 * Projects — list + per-project aggregates (ProjectMeta) used by the
 * sidebar and project-deletion logic. Pulls together a lot of joins
 * (tickets, _messages, pings) but stays a pure read API.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

export function listProjects(): string[] {
    const db = getDb();
    const rows = db.selectDistinct({ project: schema.tickets.project })
        .from(schema.tickets)
        .orderBy(asc(schema.tickets.project))
        .all();
    return rows.map((r) => r.project);
}

export interface ProjectMeta {
    name: string;
    last_activity: string;
    ticket_count: number;
    comment_count: number;
    pending_count: number;
    /** Unread pings the given consumer has on this project. Set only when
     *  listProjectsDetailed is called with a consumer_id. */
    unread_for_consumer?: number;
    /** Approved tickets currently in an open lifecycle state (i.e. no
     *  terminal close, not snoozed). Independent of the moderation pending_count. */
    open_count?: number;
    /** Approved tickets currently snoozed (postponed_until > now). Excluded
     *  from open_count above; surfaced separately so the UI can toggle a
     *  "show snoozed" mode that merges the two counts (per #B.329). */
    snoozed_count?: number;
    /** Approved+open tickets with at least one PENDING `ticket_resolved`
     *  proposal — the reporter needs to accept-and-close (or reject) it. */
    resolved_count?: number;
}

export function listProjectsDetailed(consumer_id?: string): ProjectMeta[] {
    const db = getDb();
    // Aggregates by project across tickets + messages. Two queries merged
    // in JS — small data sizes, simpler than a SQL UNION/GROUP dance.
    const ticketAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.tickets.createdAt})`,
        ticket_count: sql<number>`COUNT(*)`,
        ticket_pending: sql<number>`SUM(CASE WHEN ${schema.tickets.status} = 'pending' THEN 1 ELSE 0 END)`,
    }).from(schema.tickets).groupBy(schema.tickets.project).all();

    // pending_count == "moderation backlog the human needs to look at".
    // Only `comment_added` lifecycle counts here — pending lifecycle events
    // (ticket_resolved / ticket_closed / ticket_reopened) are not part of
    // the moderation queue. ticket_resolved pendings surface as a separate
    // `pending_resolution` row tint in the inbox (action on the reporter,
    // not the moderator). Pending ticket_closed/reopened on already-closed
    // tickets are moot and get auto-rejected by submitMessage forward, plus
    // backfill-rejected as a one-shot.
    const messageAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.messages.createdAt})`,
        comment_count: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' THEN 1 ELSE 0 END)`,
        message_pending: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' AND ${schema.messages.status} = 'pending' THEN 1 ELSE 0 END)`,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .groupBy(schema.tickets.project)
        .all();

    const byProject = new Map<string, ProjectMeta>();
    for (const t of ticketAgg) {
        byProject.set(t.project, {
            name: t.project,
            last_activity: t.last_activity ?? "",
            ticket_count: Number(t.ticket_count),
            comment_count: 0,
            pending_count: Number(t.ticket_pending) || 0,
        });
    }
    for (const m of messageAgg) {
        const cur = byProject.get(m.project);
        const lastActivity = m.last_activity ?? "";
        if (cur) {
            cur.comment_count = Number(m.comment_count) || 0;
            cur.pending_count += Number(m.message_pending) || 0;
            if (lastActivity > cur.last_activity) cur.last_activity = lastActivity;
        } else {
            byProject.set(m.project, {
                name: m.project,
                last_activity: lastActivity,
                ticket_count: 0,
                comment_count: Number(m.comment_count) || 0,
                pending_count: Number(m.message_pending) || 0,
            });
        }
    }
    // Lifecycle replay across (closed/reopened) events in id order so we
    // know which tickets are currently closed.
    const lifecycle = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    const closedByTicket = new Map<number, boolean>();
    for (const ev of lifecycle) {
        closedByTicket.set(ev.ticket_id, ev.kind === "ticket_closed");
    }

    // Pending resolution proposals: tickets with at least one
    // `ticket_resolved` row in status=pending awaiting moderator
    // accept/reject. The sidebar badge surfaces this as "I have a
    // decision to make" — the user explicitly asked for the green count
    // to map to *waiting on my accept*, not to *already accepted*.
    const pendingResolveds = db.select({
        project: schema.tickets.project,
        ticket_id: schema.messages.ticketId,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.messages.kind, "ticket_resolved"),
            eq(schema.messages.status, "pending"),
        ))
        .all();
    const pendingResolutionTickets = new Map<string, Set<number>>();
    for (const r of pendingResolveds) {
        let s = pendingResolutionTickets.get(r.project);
        if (!s) {
            s = new Set();
            pendingResolutionTickets.set(r.project, s);
        }
        s.add(r.ticket_id);
    }

    const openCounts = db.select({
        project: schema.tickets.project,
        id: schema.tickets.id,
        status: schema.tickets.status,
        postponedUntil: schema.tickets.postponedUntil,
    }).from(schema.tickets).all();
    const nowStr = nowIso();
    const openPerProject = new Map<string, number>();
    const snoozedPerProject = new Map<string, number>();
    for (const t of openCounts) {
        if (t.status !== "approved") continue;
        const closedByLifecycle = closedByTicket.get(t.id) === true;
        if (closedByLifecycle) continue;
        const snoozed = !!t.postponedUntil && t.postponedUntil > nowStr;
        if (snoozed) {
            snoozedPerProject.set(t.project, (snoozedPerProject.get(t.project) ?? 0) + 1);
            continue;
        }
        openPerProject.set(t.project, (openPerProject.get(t.project) ?? 0) + 1);
    }
    for (const p of byProject.values()) {
        p.open_count = openPerProject.get(p.name) ?? 0;
        p.snoozed_count = snoozedPerProject.get(p.name) ?? 0;
        // Filter the pending-resolution set to only ticket ids whose
        // parent ticket is open + approved (otherwise a stale proposal
        // on a closed ticket would inflate the count).
        const candidates = pendingResolutionTickets.get(p.name);
        if (!candidates) {
            p.resolved_count = 0;
        } else {
            let n = 0;
            for (const tid of candidates) {
                const t = openCounts.find((x) => x.id === tid);
                if (!t || t.status !== "approved") continue;
                if (closedByTicket.get(tid) === true) continue;
                n++;
            }
            p.resolved_count = n;
        }
    }

    if (consumer_id) {
        // Per-project unread for this consumer = **count of distinct OPEN
        // tickets** that have at least one unseen ping (NOT count of pings,
        // and **closed/rejected tickets are excluded**). This matches the
        // default "Unread" filter in the UI, which lives behind the
        // `onlyOpen=true` filter most of the time — so the sidebar badge
        // and the row list agree on the same number.
        //
        // Two sources of ticket ids: pings on the ticket-root, pings on
        // any of its comments. Merge into a Set per project, then drop
        // tickets that the lifecycle replay above flagged as closed.
        // Self-pings are filtered (an agent's own posts don't count as
        // unread for themselves).
        const ticketIdsFromTicketPings = db.select({
            ticket_id: schema.tickets.id,
            project: schema.tickets.project,
        })
            .from(schema.pings)
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.messageId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
                or(
                    isNull(schema.tickets.byAgent),
                    ne(schema.tickets.byAgent, consumer_id),
                ),
            ))
            .all();
        const ticketIdsFromCommentPings = db.select({
            ticket_id: schema.messages.ticketId,
            project: schema.tickets.project,
        })
            .from(schema.pings)
            .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.messageId))
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
            .where(and(
                eq(schema.pings.recipient, consumer_id),
                isNull(schema.pings.seenAt),
                or(
                    isNull(schema.messages.byAgent),
                    ne(schema.messages.byAgent, consumer_id),
                ),
            ))
            .all();
        const ticketStatusById = new Map<number, string>();
        for (const t of openCounts) ticketStatusById.set(t.id, t.status);
        const byProjectSets = new Map<string, Set<number>>();
        function note(project: string, ticket_id: number) {
            // Skip tickets the user can't act on directly: closed via
            // lifecycle, or moderation-rejected.
            const status = ticketStatusById.get(ticket_id);
            if (status === "rejected") return;
            if (closedByTicket.get(ticket_id) === true) return;
            let s = byProjectSets.get(project);
            if (!s) {
                s = new Set();
                byProjectSets.set(project, s);
            }
            s.add(ticket_id);
        }
        for (const r of ticketIdsFromTicketPings) note(r.project, r.ticket_id);
        for (const r of ticketIdsFromCommentPings) note(r.project, r.ticket_id);
        for (const p of byProject.values()) {
            p.unread_for_consumer = byProjectSets.get(p.name)?.size ?? 0;
        }
    }

    return [...byProject.values()].sort((a, b) =>
        b.last_activity.localeCompare(a.last_activity),
    );
}

/**
 * Hard-delete a project: every ticket (cascades to _messages, ticket_tags,
 * ticket_subscriptions via FK), every project subscription, every ping
 * targeting any of those ids (no FK on pings; cleanup is explicit).
 */
export function deleteProject(name: string): { deleted_messages: number } {
    const db = getDb();
    return db.transaction((tx) => {
        const ticketIds = tx.select({ id: schema.tickets.id })
            .from(schema.tickets).where(eq(schema.tickets.project, name)).all()
            .map((r) => r.id);
        let messageIds: number[] = [];
        if (ticketIds.length) {
            messageIds = tx.select({ id: schema.messages.id })
                .from(schema.messages)
                .where(inArray(schema.messages.ticketId, ticketIds))
                .all()
                .map((r) => r.id);
        }
        const allIds = [...ticketIds, ...messageIds];
        if (allIds.length) {
            tx.delete(schema.pings).where(inArray(schema.pings.messageId, allIds)).run();
        }
        tx.delete(schema.tickets).where(eq(schema.tickets.project, name)).run();
        tx.delete(schema.subscriptions).where(eq(schema.subscriptions.project, name)).run();
        return { deleted_messages: ticketIds.length + messageIds.length };
    });
}
