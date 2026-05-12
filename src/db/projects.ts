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
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.pings.ticketId))
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
            .innerJoin(schema.messages, eq(schema.messages.id, schema.pings.commentId))
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
 * Hard-delete tickets that have been closed for more than `olderThanDays`
 * within a single project. "Closed" is the same lifecycle-replay state the
 * sidebar uses — the latest `ticket_closed`/`ticket_reopened` event must be
 * `ticket_closed`. The cutoff compares the `createdAt` of that closing
 * event against now − N days.
 *
 * Cascades: tickets → _messages, ticket_tags, ticket_subscriptions via FK;
 * pings are wiped explicitly (no FK). Child sub-tickets with parent_ticket_id
 * pointing at a purged row become top-level (ON DELETE SET NULL).
 */
export function purgeOldClosedTickets(
    project: string,
    olderThanDays: number,
): { purged_tickets: number; purged_messages: number } {
    const db = getDb();
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return db.transaction((tx) => {
        const events = tx.select({
            ticketId: schema.messages.ticketId,
            kind: schema.messages.kind,
            createdAt: schema.messages.createdAt,
            id: schema.messages.id,
        })
            .from(schema.messages)
            .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
            .where(and(
                eq(schema.tickets.project, project),
                inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
                eq(schema.messages.status, "approved"),
            ))
            .orderBy(asc(schema.messages.id))
            .all();
        const latestClose = new Map<number, string | null>();
        for (const ev of events) {
            if (ev.kind === "ticket_closed") latestClose.set(ev.ticketId, ev.createdAt);
            else latestClose.set(ev.ticketId, null);
        }
        const purgeIds: number[] = [];
        for (const [tid, closedAt] of latestClose) {
            if (closedAt !== null && closedAt < cutoff) purgeIds.push(tid);
        }
        if (purgeIds.length === 0) return { purged_tickets: 0, purged_messages: 0 };
        const messageIds = tx.select({ id: schema.messages.id })
            .from(schema.messages)
            .where(inArray(schema.messages.ticketId, purgeIds))
            .all()
            .map((r) => r.id);
        tx.delete(schema.pings).where(inArray(schema.pings.ticketId, purgeIds)).run();
        if (messageIds.length) {
            tx.delete(schema.pings).where(inArray(schema.pings.commentId, messageIds)).run();
        }
        tx.delete(schema.tickets).where(inArray(schema.tickets.id, purgeIds)).run();
        return { purged_tickets: purgeIds.length, purged_messages: messageIds.length };
    });
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
        if (ticketIds.length) {
            tx.delete(schema.pings).where(inArray(schema.pings.ticketId, ticketIds)).run();
        }
        if (messageIds.length) {
            tx.delete(schema.pings).where(inArray(schema.pings.commentId, messageIds)).run();
        }
        tx.delete(schema.tickets).where(eq(schema.tickets.project, name)).run();
        tx.delete(schema.subscriptions).where(eq(schema.subscriptions.project, name)).run();
        return { deleted_messages: ticketIds.length + messageIds.length };
    });
}

/**
 * Mantis-style rich stats for a project — surfaced on the per-project
 * page (per #B.60). Different from `getProjectStats` (which is a
 * lightweight "Nobody is listening" hint for ticket_new): this one
 * powers a dedicated dashboard, so it bundles multiple aggregates in
 * one response. Computed via several small SELECTs assembled in JS;
 * fast enough for the inbox sizes we see today.
 */
export interface ProjectStatsRich {
    project: string;

    // Pulse
    ticket_count: number;             // approved tickets total
    comment_count: number;            // approved comments total
    open_count: number;               // approved + not closed + not snoozed
    closed_count: number;             // closed tickets (regardless of resolved)
    resolved_count: number;           // closed-and-resolved tickets
    pending_mod: number;              // tickets in moderation queue
    pending_resolution: number;       // open tickets with a pending ticket_resolved proposal
    resolved_pct: number;             // resolved / (closed) — 0..100, rounded to 1 decimal

    // Live tickets
    oldest_open: { id: number; title: string; by_agent: string | null; created_at: string; age_days: number } | null;
    avg_age_open_days: number;        // arithmetic mean across open tickets, 1 decimal

    // Top N (5 each, sorted desc by count)
    top_reporters: { agent: string; count: number }[];
    top_tags: { name: string; count: number }[];
    top_intents: { intent: string; count: number }[];

    // Throughput
    auto_approved_pct: number;        // auto-decided / total decided (approved), 0..100
}

export function getProjectStatsRich(project: string): ProjectStatsRich {
    const db = getDb();
    const nowStr = nowIso();
    const nowMs = Date.now();

    // ---- Pulse ----
    const tickets = db.select({
        id: schema.tickets.id,
        status: schema.tickets.status,
        decidedBy: schema.tickets.decidedBy,
        byAgent: schema.tickets.byAgent,
        title: schema.tickets.title,
        editedTitle: schema.tickets.editedTitle,
        intent: schema.tickets.intent,
        createdAt: schema.tickets.createdAt,
        postponedUntil: schema.tickets.postponedUntil,
    }).from(schema.tickets).where(eq(schema.tickets.project, project)).all();

    const ticketCount = tickets.filter((t) => t.status === "approved").length;
    const pendingMod = tickets.filter((t) => t.status === "pending").length;

    // Lifecycle replay for closed/resolved flags on each ticket.
    const ticketIds = tickets.map((t) => t.id);
    const lifecycle = ticketIds.length ? db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
        status: schema.messages.status,
    })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.ticketId, ticketIds),
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened", "ticket_resolved"]),
        ))
        .orderBy(asc(schema.messages.id))
        .all() : [];

    const closedById = new Map<number, boolean>();
    const resolvedById = new Map<number, boolean>();
    const pendingResolvedById = new Set<number>();
    for (const ev of lifecycle) {
        if (ev.status === "pending" && ev.kind === "ticket_resolved") {
            pendingResolvedById.add(ev.ticket_id);
            continue;
        }
        if (ev.status !== "approved") continue;
        if (ev.kind === "ticket_closed") closedById.set(ev.ticket_id, true);
        else if (ev.kind === "ticket_reopened") {
            closedById.set(ev.ticket_id, false);
            resolvedById.set(ev.ticket_id, false);
        } else if (ev.kind === "ticket_resolved") resolvedById.set(ev.ticket_id, true);
    }

    let closedCount = 0;
    let resolvedCount = 0;
    let openCount = 0;
    let pendingResolutionCount = 0;
    let ageSumMs = 0;
    let oldestOpen: typeof tickets[number] | null = null;
    for (const t of tickets) {
        if (t.status !== "approved") continue;
        const closed = closedById.get(t.id) === true;
        const resolved = resolvedById.get(t.id) === true;
        const snoozed = !!t.postponedUntil && t.postponedUntil > nowStr;
        if (closed) {
            closedCount++;
            if (resolved) resolvedCount++;
            continue;
        }
        if (snoozed) continue;
        openCount++;
        if (pendingResolvedById.has(t.id)) pendingResolutionCount++;
        const ageMs = nowMs - new Date(t.createdAt).getTime();
        ageSumMs += ageMs;
        if (!oldestOpen || t.createdAt < oldestOpen.createdAt) oldestOpen = t;
    }

    const dayMs = 86_400_000;
    const oldestOpenSummary = oldestOpen ? {
        id: oldestOpen.id,
        title: oldestOpen.editedTitle ?? oldestOpen.title ?? "",
        by_agent: oldestOpen.byAgent,
        created_at: oldestOpen.createdAt,
        age_days: Math.round((nowMs - new Date(oldestOpen.createdAt).getTime()) / dayMs * 10) / 10,
    } : null;
    const avgAgeOpenDays = openCount > 0
        ? Math.round(ageSumMs / openCount / dayMs * 10) / 10
        : 0;

    const resolvedPct = closedCount > 0
        ? Math.round(resolvedCount / closedCount * 1000) / 10
        : 0;

    // ---- Comments ----
    const commentRow = db.select({ n: sql<number>`COUNT(*)` })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
        )).get();
    const commentCount = Number(commentRow?.n ?? 0);

    // ---- Top reporters (5) ----
    const reporterAgg = db.select({
        agent: schema.tickets.byAgent,
        n: sql<number>`COUNT(*)`,
    }).from(schema.tickets)
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.tickets.status, "approved"),
        ))
        .groupBy(schema.tickets.byAgent)
        .all();
    const topReporters = reporterAgg
        .filter((r) => r.agent !== null && r.agent !== undefined)
        .map((r) => ({ agent: r.agent as string, count: Number(r.n) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    // ---- Top intents (4 — there are only 4 possible values) ----
    const intentAgg = db.select({
        intent: schema.tickets.intent,
        n: sql<number>`COUNT(*)`,
    }).from(schema.tickets)
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.tickets.status, "approved"),
        ))
        .groupBy(schema.tickets.intent)
        .all();
    const topIntents = intentAgg
        .filter((r) => r.intent !== null && r.intent !== undefined)
        .map((r) => ({ intent: r.intent as string, count: Number(r.n) }))
        .sort((a, b) => b.count - a.count);

    // ---- Top tags (5) ----
    const tagAgg = ticketIds.length ? db.select({
        name: schema.tags.name,
        n: sql<number>`COUNT(*)`,
    }).from(schema.ticketTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.ticketTags.tagId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketTags.ticketId))
        .where(and(
            eq(schema.tickets.project, project),
            eq(schema.tickets.status, "approved"),
        ))
        .groupBy(schema.tags.name)
        .all() : [];
    const topTags = tagAgg
        .map((r) => ({ name: r.name, count: Number(r.n) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    // ---- Throughput (auto-approved %) ----
    const decided = tickets.filter((t) => t.status === "approved");
    const auto = decided.filter((t) => t.decidedBy === "auto" || t.decidedBy === "owner").length;
    const autoApprovedPct = decided.length > 0
        ? Math.round(auto / decided.length * 1000) / 10
        : 0;

    return {
        project,
        ticket_count: ticketCount,
        comment_count: commentCount,
        open_count: openCount,
        closed_count: closedCount,
        resolved_count: resolvedCount,
        pending_mod: pendingMod,
        pending_resolution: pendingResolutionCount,
        resolved_pct: resolvedPct,
        oldest_open: oldestOpenSummary,
        avg_age_open_days: avgAgeOpenDays,
        top_reporters: topReporters,
        top_tags: topTags,
        top_intents: topIntents,
        auto_approved_pct: autoApprovedPct,
    };
}
