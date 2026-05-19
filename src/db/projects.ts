/**
 * Projects — list + per-project aggregates (ProjectMeta) used by the
 * sidebar and project-deletion logic. Pulls together a lot of joins
 * (tickets, _messages, pings) but stays a pure read API.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

/**
 * Project names known to the system. Reads from the explicit `projects`
 * registry (#B.216 phase A pass 1) AND the legacy DISTINCT(tickets.project)
 * path — soft FK by design, so an orphan ticket on an unregistered project
 * is still visible here, and a freshly-created empty project (registered
 * via CLI/UI before any ticket lands) is also visible.
 */
export function listProjects(): string[] {
    const db = getDb();
    const registry = db.select({ name: schema.projects.name })
        .from(schema.projects)
        .all()
        .map((r) => r.name);
    const fromTickets = db.selectDistinct({ project: schema.tickets.project })
        .from(schema.tickets)
        .all()
        .map((r) => r.project);
    const merged = new Set<string>([...registry, ...fromTickets]);
    return [...merged].sort((a, b) => a.localeCompare(b));
}

/**
 * Insert a new project into the registry. Soft registry: no SQL FK ties
 * tickets.project to this row, but the CLI / Web UI flows go through
 * here to declare a project before its first ticket lands.
 *
 * Throws on duplicate name (PK collision) — caller decides whether to
 * treat that as a 409 or surface it raw.
 */
export interface NewProjectInput {
    name: string;
    display_name?: string | null;
    description?: string | null;
    created_by?: string | null;
}

export function createProject(input: NewProjectInput): schema.Project {
    const db = getDb();
    const name = input.name.trim();
    if (!name) throw new Error("project name is required");
    const row: schema.NewProject = {
        name,
        displayName: input.display_name ?? null,
        description: input.description ?? null,
        createdAt: nowIso(),
        createdBy: input.created_by ?? null,
    };
    db.insert(schema.projects).values(row).run();
    const inserted = db.select().from(schema.projects)
        .where(eq(schema.projects.name, name))
        .get();
    if (!inserted) throw new Error(`project ${name} disappeared after insert`);
    return inserted;
}

export function getProject(name: string): schema.Project | undefined {
    const db = getDb();
    return db.select().from(schema.projects)
        .where(eq(schema.projects.name, name))
        .get();
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
    /** Subset of `open_count`: tickets that have NOT been marked
     *  resolved by an agent. Used by the autopoll hook (#B.119) so
     *  the agent isn't nagged about tickets already in the reporter's
     *  court awaiting close. `open_count - actionable_count` = the
     *  number of "agent-done, human-pending" tickets. */
    actionable_count?: number;
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
    // Snoozed-pending tickets are explicitly set aside — they should NOT
    // count in the sidebar pending badge (the human chose to defer them).
    // Pattern: ticket_pending counts only pending tickets whose
    // postponed_until is NULL or already past. Same idea for comments
    // whose parent ticket is currently snoozed.
    const nowIsoStr = nowIso();
    const ticketAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.tickets.createdAt})`,
        ticket_count: sql<number>`COUNT(*)`,
        ticket_pending: sql<number>`SUM(CASE
            WHEN ${schema.tickets.status} = 'pending'
             AND (${schema.tickets.postponedUntil} IS NULL
                  OR ${schema.tickets.postponedUntil} <= ${nowIsoStr})
            THEN 1 ELSE 0 END)`,
    }).from(schema.tickets).groupBy(schema.tickets.project).all();

    // pending_count == "moderation backlog the human needs to look at".
    // Only `comment_added` lifecycle counts here — pending lifecycle events
    // (ticket_resolved / ticket_closed / ticket_reopened) are not part of
    // the moderation queue. ticket_resolved pendings surface as a separate
    // `pending_resolution` row tint in the inbox (action on the reporter,
    // not the moderator). Pending ticket_closed/reopened on already-closed
    // tickets are moot and get auto-rejected by submitMessage forward, plus
    // backfill-rejected as a one-shot.
    // Snoozed parent tickets exclude their pending comments from the count
    // for the same reason as above.
    const messageAgg = db.select({
        project: schema.tickets.project,
        last_activity: sql<string>`MAX(${schema.messages.createdAt})`,
        comment_count: sql<number>`SUM(CASE WHEN ${schema.messages.kind} = 'comment_added' THEN 1 ELSE 0 END)`,
        message_pending: sql<number>`SUM(CASE
            WHEN ${schema.messages.kind} = 'comment_added'
             AND ${schema.messages.status} = 'pending'
             AND (${schema.tickets.postponedUntil} IS NULL
                  OR ${schema.tickets.postponedUntil} <= ${nowIsoStr})
            THEN 1 ELSE 0 END)`,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .groupBy(schema.tickets.project)
        .all();

    const byProject = new Map<string, ProjectMeta>();
    // #B.227: seed from the projects registry first so a freshly-
    // registered empty project (auto-register at claude-loop start,
    // or `aiball project init`) still surfaces in the sidebar with
    // zero counts. Before this seed, byProject was built only from
    // ticket/message aggs and empty projects silently disappeared.
    const registry = db.select({
        name: schema.projects.name,
        created_at: schema.projects.createdAt,
    }).from(schema.projects).all();
    for (const r of registry) {
        byProject.set(r.name, {
            name: r.name,
            last_activity: r.created_at ?? "",
            ticket_count: 0,
            comment_count: 0,
            pending_count: 0,
        });
    }
    for (const t of ticketAgg) {
        const existing = byProject.get(t.project);
        const last = t.last_activity ?? "";
        if (existing) {
            existing.ticket_count = Number(t.ticket_count);
            existing.pending_count = Number(t.ticket_pending) || 0;
            if (last && last > existing.last_activity) existing.last_activity = last;
        } else {
            byProject.set(t.project, {
                name: t.project,
                last_activity: last,
                ticket_count: Number(t.ticket_count),
                comment_count: 0,
                pending_count: Number(t.ticket_pending) || 0,
            });
        }
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
    // Lifecycle replay across (closed/reopened/resolved/blocked) events
    // in id order so we know which tickets are currently closed AND which
    // have been marked resolved or blocked by an agent (waiting for the
    // reporter to act). Both resolved and blocked tickets are excluded
    // from `actionable_count` (#B.119): they're in the human's court now,
    // the agent shouldn't be nagged about them by autopoll. We consider
    // BOTH approved and pending ticket_resolved (#B.120) — a pending
    // proposal is still the agent saying "I'm done", even if the reporter
    // hasn't validated yet. `ticket_blocked` always auto-approves so
    // pending-vs-approved doesn't matter there.
    const lifecycle = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        status: schema.messages.status,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened", "ticket_resolved", "ticket_blocked"]),
        )
        .orderBy(asc(schema.messages.id))
        .all();
    const closedByTicket = new Map<number, boolean>();
    const resolvedByTicket = new Map<number, boolean>();
    const blockedByTicket = new Map<number, boolean>();
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") {
            // Close needs to be approved to count (rejected closes
            // shouldn't shut a ticket).
            if (ev.status === "approved") closedByTicket.set(ev.ticket_id, true);
        } else if (ev.kind === "ticket_reopened") {
            if (ev.status === "approved") {
                closedByTicket.set(ev.ticket_id, false);
                resolvedByTicket.set(ev.ticket_id, false);
                blockedByTicket.set(ev.ticket_id, false);
            }
        } else if (ev.kind === "ticket_resolved") {
            // Pending OR approved counts as "agent done".
            if (ev.status === "approved" || ev.status === "pending") {
                resolvedByTicket.set(ev.ticket_id, true);
            }
        } else if (ev.kind === "ticket_blocked") {
            // ticket_blocked is always auto-approved (it's a signal,
            // not a contested mutation) but be defensive anyway.
            if (ev.status === "approved" || ev.status === "pending") {
                blockedByTicket.set(ev.ticket_id, true);
            }
        }
    }

    // #B.218: subtract pending tickets that are currently closed from
    // pending_count. The SQL agg above counts every pending ticket
    // regardless of close state — a moderator who closed a pending
    // ticket without approving (wontfix / abandoned) still saw it in
    // the badge. Walk the pending tickets, check lifecycle, decrement
    // per-project pending_count when closed-without-reopen.
    const pendingTickets = db.select({
        id: schema.tickets.id,
        project: schema.tickets.project,
    })
        .from(schema.tickets)
        .where(and(
            eq(schema.tickets.status, "pending"),
            or(isNull(schema.tickets.postponedUntil), lte(schema.tickets.postponedUntil, nowIsoStr)),
        ))
        .all();
    for (const t of pendingTickets) {
        if (closedByTicket.get(t.id) !== true) continue;
        const cur = byProject.get(t.project);
        if (cur && cur.pending_count > 0) cur.pending_count -= 1;
    }

    // #B.129 phase 2: layer decision-on-comment resolutions on top of
    // the lifecycle replay. A comment with `meta.decision.kind=
    // "resolution"` in any status (pending or accepted) means "agent
    // proposed done" — same effect on actionable_count as a legacy
    // ticket_resolved row. We can't reliably re-do the
    // reopen-clears-resolved ordering here without re-sorting events,
    // but the existing replay already cleared resolvedByTicket on the
    // last reopen seen; a NEW resolution comment after that reopen
    // will set it again here, which is the correct semantic.
    const resolutionComments = db.select({
        ticket_id: schema.messages.ticketId,
        meta: schema.messages.meta,
        status: schema.messages.status,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    for (const c of resolutionComments) {
        if (!c.meta) continue;
        try {
            const m = JSON.parse(c.meta) as { decision?: { kind?: string; status?: string } };
            const d = m.decision;
            if (d?.kind === "resolution" && (d.status === "pending" || d.status === "accepted")) {
                resolvedByTicket.set(c.ticket_id, true);
            }
        } catch { /* malformed meta, skip */ }
    }

    // Pending resolution proposals: tickets with at least one
    // resolution awaiting reporter accept. Two shapes since #B.129
    // phase 2: legacy `ticket_resolved` row in status=pending OR a
    // `comment_added` carrying `meta.decision={kind:"resolution",
    // status:"pending"}`. Either way the moderator/reporter has a
    // decision to make.
    const legacyPendingResolveds = db.select({
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
    const decisionPendingResolveds = db.select({
        project: schema.tickets.project,
        ticket_id: schema.messages.ticketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(and(
            eq(schema.messages.kind, "comment_added"),
            eq(schema.messages.status, "approved"),
        ))
        .all();
    const pendingResolutionTickets = new Map<string, Set<number>>();
    function bumpPending(project: string, ticketId: number): void {
        let s = pendingResolutionTickets.get(project);
        if (!s) {
            s = new Set();
            pendingResolutionTickets.set(project, s);
        }
        s.add(ticketId);
    }
    for (const r of legacyPendingResolveds) bumpPending(r.project, r.ticket_id);
    for (const r of decisionPendingResolveds) {
        if (!r.meta) continue;
        try {
            const m = JSON.parse(r.meta) as { decision?: { kind?: string; status?: string } };
            if (m.decision?.kind === "resolution" && m.decision.status === "pending") {
                bumpPending(r.project, r.ticket_id);
            }
        } catch { /* malformed meta, skip */ }
    }

    const openCounts = db.select({
        project: schema.tickets.project,
        id: schema.tickets.id,
        status: schema.tickets.status,
        postponedUntil: schema.tickets.postponedUntil,
    }).from(schema.tickets).all();
    const nowStr = nowIso();
    const openPerProject = new Map<string, number>();
    const actionablePerProject = new Map<string, number>();
    const snoozedPerProject = new Map<string, number>();

    // #B.123 phase B.4: gate actionable_count on active depends_on
    // relations to an OPEN blocker. Walk all ticket_relation events in
    // id order, keep the latest per (source, target) pair, then build
    // the set of ticket ids whose latest active relation says "blocked
    // by something still open". A `blocks` from A→B is the inverse of
    // depends_on from B→A; both forms gate the dependent ticket.
    const openTicketIds = new Set<number>();
    for (const t of openCounts) {
        if (t.status !== "approved") continue;
        if (closedByTicket.get(t.id) === true) continue;
        if (t.postponedUntil && t.postponedUntil > nowStr) continue;
        openTicketIds.add(t.id);
    }
    const latestRelations = db.select({
        sourceTicketId: schema.messages.ticketId,
        targetTicketId: schema.messages.sourceTicketId,
        meta: schema.messages.meta,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.kind, "ticket_relation"),
            eq(schema.messages.status, "approved"),
        ))
        .orderBy(schema.messages.id)
        .all();
    const latestPerPair = new Map<string, { source: number; target: number; kind: string }>();
    for (const r of latestRelations) {
        if (!r.meta || !r.targetTicketId) continue;
        let kind: string | undefined;
        try {
            const m = JSON.parse(r.meta) as { relation?: { kind?: string } };
            kind = m.relation?.kind;
        } catch { continue; }
        if (!kind) continue;
        latestPerPair.set(`${r.sourceTicketId}-${r.targetTicketId}`, {
            source: r.sourceTicketId,
            target: r.targetTicketId,
            kind,
        });
    }
    const gatedByBlocker = new Set<number>();
    for (const r of latestPerPair.values()) {
        if (r.kind === "depends_on" && openTicketIds.has(r.target)) {
            gatedByBlocker.add(r.source);
        } else if (r.kind === "blocks" && openTicketIds.has(r.source)) {
            // A blocks B → B is gated when A is open.
            gatedByBlocker.add(r.target);
        }
    }

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
        // Actionable = open and NOT marked resolved/blocked by an agent
        // AND not gated by an active depends_on to an open blocker
        // (#B.123 phase B.4). The autopoll trigger uses this so:
        //   - a resolved/blocked ticket doesn't nag (#B.119)
        //   - a ticket waiting on an unfinished dependency doesn't
        //     surface as work to do (gating clears when blocker closes)
        const isResolved = resolvedByTicket.get(t.id) === true;
        const isBlocked = blockedByTicket.get(t.id) === true;
        const isGated = gatedByBlocker.has(t.id);
        if (!isResolved && !isBlocked && !isGated) {
            actionablePerProject.set(t.project, (actionablePerProject.get(t.project) ?? 0) + 1);
        }
    }
    for (const p of byProject.values()) {
        p.open_count = openPerProject.get(p.name) ?? 0;
        p.actionable_count = actionablePerProject.get(p.name) ?? 0;
        p.snoozed_count = snoozedPerProject.get(p.name) ?? 0;
        // Filter the pending-resolution set to only ticket ids whose
        // parent ticket is open + approved + NOT snoozed (otherwise a
        // stale proposal on a closed/snoozed ticket would inflate the
        // sidebar badge — david #B.138: "2 open mais 4 résolu mais 2
        // en liste"). The default inbox list hides snoozed; the badge
        // count must match that filter to stay legible.
        const candidates = pendingResolutionTickets.get(p.name);
        if (!candidates) {
            p.resolved_count = 0;
        } else {
            let n = 0;
            for (const tid of candidates) {
                const t = openCounts.find((x) => x.id === tid);
                if (!t || t.status !== "approved") continue;
                if (closedByTicket.get(tid) === true) continue;
                const snoozed = !!t.postponedUntil && t.postponedUntil > nowStr;
                if (snoozed) continue;
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
