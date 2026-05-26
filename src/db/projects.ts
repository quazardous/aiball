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
import { isForeignActor, eventHasForeignActor, isExcludedForConsumer } from "./last-actor-gate.js";
import { isHeldByOther } from "./assignment-gate.js";
import { assignWindowSec } from "../autopoll/config.js";
import { listHumans } from "./consumers.js";
import { computeDecisionGate } from "./decision-gate.js";
import { getTicketTokenUsage, type TokenTally } from "./token-usage.js";
import { landscapeHash, type LandscapeEntry } from "./landscape.js";
import { presenceRunning } from "../live-presence.js";
import { tagsForMessages } from "./tags.js";
import { getEnabledWorkFiltersForConsumer, ticketPassesWorkFilters } from "./work-filters.js";

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
    /** #379: signature du paysage ouvert (sha1 des `<id>:<last_actor_at>` triés
     *  des tickets ouverts non-snoozés de ce projet). Calculé seulement quand
     *  `listProjectsDetailed` est appelé avec `landscape=true` (flag `&landscape=1`)
     *  — seul le timer claude-loop le demande, pas les polls UI. Primitif partagé
     *  reset + dédup set-aware de la drained-strategy. */
    landscape_hash?: string;
    /** #379: dernière activité (`max(last_actor_at)`) sur les tickets ouverts —
     *  alimente la stratégie `stale` (wake si `now - landscape_last_activity > seuil`).
     *  Null si aucun ticket ouvert n'a de `last_actor_at`. Posé avec `landscape_hash`. */
    landscape_last_activity?: string | null;
    /** #393: true when a claude-loop with a known root has worked this project
     *  (root discoverable from a pushed consumer `cwd`) → the project is "local"
     *  and can be (re)launched from the UI. The root persists even when the loop
     *  is stopped, so this means "root known", not "currently running". */
    local?: boolean;
    /** #393: distinct loop roots known for this project (from `consumers.cwd`).
     *  Usually one (a dir = one project). Empty/undefined when not local. */
    roots?: string[];
    /** #393 (3c): true when a claude-loop is **currently running** for this
     *  project — a rooted consumer heartbeated within RUNNING_WINDOW_MS.
     *  Distinct from `local` (root known, loop maybe stopped). */
    running?: boolean;
    /** #395 (q3bfvn): the running loop's activity state (busy/idle/boot), so the
     *  UI can show a tag like ConsumersPanel. Only set when `running`. */
    running_state?: string;
    /** #395 (q3bfvn): the running loop has a live human driving it (#280). */
    running_human?: boolean;
    /** #395 (q3bfvn): the running loop's 3-state presence word (stop/wait/loop,
     *  #310) — drives the presence chip colour. Only set when `running`. */
    running_human_word?: string;
    /** #406 (david `chhv9c`): cumulative per-project token-effort tally —
     *  raw counts summed across the project's tickets, `null`/undefined until
     *  any usage is captured. The Projects list shows a derived cost estimate
     *  (cache_r weighted 0.1×, like the per-ticket badge). */
    token_usage?: TokenTally | null;
}

/** #393 (3c): a loop is "running" when its consumer heartbeated this recently. */
const RUNNING_WINDOW_MS = 120_000;

/**
 * #395: a consumer's effective running state. Presence (live SSE) is
 * AUTHORITATIVE — `true` while connected, `false` once seen-then-gone (so a
 * just-dead loop with a still-fresh heartbeat reads stopped *immediately*,
 * instead of lingering up to RUNNING_WINDOW_MS). The heartbeat window is only a
 * bridge for consumers never seen via SSE this session (e.g. right after a
 * daemon restart, before loops reconnect).
 */
function consumerEffectiveRunning(consumerId: string, stateUpdatedAt: string | null, cutoff: string): boolean {
    const verdict = presenceRunning(consumerId);
    if (verdict !== null) return verdict;
    return stateUpdatedAt != null && stateUpdatedAt >= cutoff;
}

/** #393 (3c) + #395: is a claude-loop currently running at this exact root?
 *  Presence-aware (see consumerEffectiveRunning). Used to gate launch (no
 *  duplicate) + the per-project `running` flag. */
export function isRootActive(root: string): boolean {
    if (!root) return false;
    const cutoff = new Date(Date.now() - RUNNING_WINDOW_MS).toISOString();
    const rows = getDb().select({
        consumerId: schema.consumers.consumerId,
        stateUpdatedAt: schema.consumers.stateUpdatedAt,
    })
        .from(schema.consumers)
        .where(sql`${schema.consumers.cwd} = ${root}`)
        .all();
    return rows.some((c) => consumerEffectiveRunning(c.consumerId, c.stateUpdatedAt, cutoff));
}

export function listProjectsDetailed(consumer_id?: string, landscape = false): ProjectMeta[] {
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
    // #406 (david chhv9c): cumulative token effort per project, for the
    // Projects-list column. Raw sums across the project's tickets; the UI
    // derives the cost estimate. Only attached when a project has any usage.
    const tokenAgg = db.select({
        project: schema.tickets.project,
        tokens_in: sql<number>`COALESCE(SUM(${schema.ticketTokenUsage.tokensIn}), 0)`,
        tokens_out: sql<number>`COALESCE(SUM(${schema.ticketTokenUsage.tokensOut}), 0)`,
        cache_w: sql<number>`COALESCE(SUM(${schema.ticketTokenUsage.cacheW}), 0)`,
        cache_r: sql<number>`COALESCE(SUM(${schema.ticketTokenUsage.cacheR}), 0)`,
        updated_at: sql<string>`MAX(${schema.ticketTokenUsage.updatedAt})`,
    })
        .from(schema.ticketTokenUsage)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketTokenUsage.ticketId))
        .groupBy(schema.tickets.project)
        .all();
    for (const tk of tokenAgg) {
        const cur = byProject.get(tk.project);
        const total = Number(tk.tokens_in) + Number(tk.tokens_out) + Number(tk.cache_w) + Number(tk.cache_r);
        if (cur && total > 0) {
            cur.token_usage = {
                tokens_in: Number(tk.tokens_in),
                tokens_out: Number(tk.tokens_out),
                cache_w: Number(tk.cache_w),
                cache_r: Number(tk.cache_r),
                updated_at: tk.updated_at ?? "",
            };
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
    // #273: latest-decision-wins gate (legacy ticket_resolved/reopened +
    // decision-on-comment, last signal per ticket). Replaces the old
    // monotonic gate that the lifecycle loop + decision block used to set.
    const gatedByDecisionByTicket = decisionGateByTicket();
    const blockedByTicket = new Map<number, boolean>();
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") {
            // Close needs to be approved to count (rejected closes
            // shouldn't shut a ticket).
            if (ev.status === "approved") closedByTicket.set(ev.ticket_id, true);
        } else if (ev.kind === "ticket_reopened") {
            if (ev.status === "approved") {
                closedByTicket.set(ev.ticket_id, false);
                blockedByTicket.set(ev.ticket_id, false);
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

    // #273: the decision-on-comment gate now lives in decisionGateByTicket()
    // (latest-decision-wins), folded into gatedByDecisionByTicket above.

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
        // #379: `last_actor_at` (#374) ajouté au SELECT existant → zéro requête
        // en plus ; alimente le landscape_hash (gated par le flag `landscape`).
        lastActorAt: schema.tickets.lastActorAt,
    }).from(schema.tickets).all();
    const nowStr = nowIso();
    const openPerProject = new Map<string, number>();
    const actionablePerProject = new Map<string, number>();
    const snoozedPerProject = new Map<string, number>();
    // #379: par projet, les entrées de paysage (tickets ouverts non-snoozés) +
    // la dernière activité. Peuplé seulement quand `landscape` est demandé.
    const landscapeEntriesPerProject = new Map<string, LandscapeEntry[]>();
    const landscapeLastActivityPerProject = new Map<string, string>();

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

    // #265/#374: per-consumer "I acted last → awaiting someone else" gate,
    // applied to actionable_count exactly like the SET path
    // (computeActionableTicketIds). Only when a consumer is in scope;
    // global callers keep pre-#265 behaviour. #374: last_actor + sole-participant.
    const awaitingOtherSet = consumer_id ? lastActorExclusions(consumer_id) : null;

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
        if (landscape) {
            let entries = landscapeEntriesPerProject.get(t.project);
            if (!entries) { entries = []; landscapeEntriesPerProject.set(t.project, entries); }
            entries.push({ id: t.id, lastActorAt: t.lastActorAt ?? null });
            if (t.lastActorAt && (landscapeLastActivityPerProject.get(t.project) ?? "") < t.lastActorAt) {
                landscapeLastActivityPerProject.set(t.project, t.lastActorAt);
            }
        }
        // Actionable = open and NOT marked resolved/blocked by an agent
        // AND not gated by an active depends_on to an open blocker
        // (#B.123 phase B.4) AND not awaiting-someone-else for this
        // consumer (#265). The autopoll trigger uses this so:
        //   - a resolved/blocked ticket doesn't nag (#B.119)
        //   - a ticket waiting on an unfinished dependency doesn't
        //     surface as work to do (gating clears when blocker closes)
        //   - a ticket where the agent already replied last doesn't nag
        //     while it's in the human's court (#239 conversational case)
        const isGatedByDecision = gatedByDecisionByTicket.get(t.id) === true;
        const isBlocked = blockedByTicket.get(t.id) === true;
        const isGated = gatedByBlocker.has(t.id);
        const isAwaitingOther = !!awaitingOtherSet && awaitingOtherSet.has(t.id);
        if (!isGatedByDecision && !isBlocked && !isGated && !isAwaitingOther) {
            actionablePerProject.set(t.project, (actionablePerProject.get(t.project) ?? 0) + 1);
        }
    }
    for (const p of byProject.values()) {
        p.open_count = openPerProject.get(p.name) ?? 0;
        p.actionable_count = actionablePerProject.get(p.name) ?? 0;
        p.snoozed_count = snoozedPerProject.get(p.name) ?? 0;
        if (landscape) {
            // sha1 sur les tickets ouverts non-snoozés de la vision agent (#379).
            p.landscape_hash = landscapeHash(landscapeEntriesPerProject.get(p.name) ?? []);
            p.landscape_last_activity = landscapeLastActivityPerProject.get(p.name) ?? null;
        }
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
        const snoozedTicketIds = new Set<number>();
        for (const t of openCounts) {
            ticketStatusById.set(t.id, t.status);
            if (t.postponedUntil && t.postponedUntil > nowStr) snoozedTicketIds.add(t.id);
        }
        const byProjectSets = new Map<string, Set<number>>();
        function note(project: string, ticket_id: number) {
            // #456: le compteur unread DOIT matcher EXACTEMENT le filtre par
            // défaut de l'inbox (open + approved + non-snoozé) — sinon des
            // tickets cachés gonflent le badge avec un unread « introuvable ».
            // Bug : on n'excluait que rejected + closed → les tickets PENDING
            // (en modération) et SNOOZÉS comptaient alors qu'ils ne sont pas
            // dans l'inbox. On aligne sur le même filtre que openPerProject.
            const status = ticketStatusById.get(ticket_id);
            if (status !== "approved") return; // exclut rejected ET pending
            if (closedByTicket.get(ticket_id) === true) return; // exclut fermés
            if (snoozedTicketIds.has(ticket_id)) return; // exclut snoozés (hors inbox)
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

    // #393: derive "local" — a project is local when a claude-loop with a known
    // root has worked it. The root comes from consumers.cwd (pushed by the loop's
    // state heartbeat). The root persists even when the loop is stopped, so
    // "local" = "root known → can (re)launch".
    const rootsByProject = new Map<string, Set<string>>();
    const addRoot = (project: string | null | undefined, cwd: string | null | undefined) => {
        if (!project || !cwd) return;
        let s = rootsByProject.get(project);
        if (!s) { s = new Set<string>(); rootsByProject.set(project, s); }
        s.add(cwd);
    };
    // #393 (Option A) — PRIMARY: exact root↔project straight from the consumer's
    // own pushed (project, cwd). No ticket join → no over-attribution (a loop is
    // attributed to EXACTLY its project, not every project the consumer posted on).
    for (const r of db.select({ project: schema.consumers.project, cwd: schema.consumers.cwd })
        .from(schema.consumers)
        .where(sql`${schema.consumers.cwd} IS NOT NULL AND ${schema.consumers.cwd} != ''
            AND ${schema.consumers.project} IS NOT NULL AND ${schema.consumers.project} != ''`)
        .all()) addRoot(r.project, r.cwd);
    // #393 phase-1 FALLBACK — only for consumers that pushed a cwd but NO project
    // (pre-Option-A loop, or not-yet-re-heartbeated): recover the root via authored
    // content (comments + root tickets). Self-heals to the exact path above on the
    // consumer's next heartbeat; over-attribution is confined to these legacy rows.
    const rootedNoProject = sql`${schema.consumers.cwd} IS NOT NULL AND ${schema.consumers.cwd} != ''
        AND (${schema.consumers.project} IS NULL OR ${schema.consumers.project} = '')`;
    for (const r of db.select({ project: schema.tickets.project, cwd: schema.consumers.cwd })
        .from(schema.consumers)
        .innerJoin(schema.messages, eq(schema.messages.byAgent, schema.consumers.consumerId))
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.messages.ticketId))
        .where(rootedNoProject)
        .groupBy(schema.tickets.project, schema.consumers.cwd)
        .all()) addRoot(r.project, r.cwd);
    for (const r of db.select({ project: schema.tickets.project, cwd: schema.consumers.cwd })
        .from(schema.consumers)
        .innerJoin(schema.tickets, eq(schema.tickets.byAgent, schema.consumers.consumerId))
        .where(rootedNoProject)
        .groupBy(schema.tickets.project, schema.consumers.cwd)
        .all()) addRoot(r.project, r.cwd);
    // #393 (3c) + #395: which roots have a currently-RUNNING loop. Presence
    // (live SSE) is authoritative per consumer; the 120s heartbeat is only the
    // bridge for consumers never seen via SSE this session → a dead loop reads
    // stopped near-realtime instead of lingering up to RUNNING_WINDOW_MS.
    const cutoff = new Date(Date.now() - RUNNING_WINDOW_MS).toISOString();
    const runningRoots = new Set<string>();
    // #395 (q3bfvn): also capture the running loop's activity state per root, so
    // the UI can show a busy/idle/boot tag (+ loop/human) next to `running`,
    // like ConsumersPanel. Prefer a `busy` consumer when a root has several.
    const runningStateByRoot = new Map<string, { state: string | null; human: boolean; word: string | null }>();
    for (const c of db.select({
        consumerId: schema.consumers.consumerId,
        cwd: schema.consumers.cwd,
        stateUpdatedAt: schema.consumers.stateUpdatedAt,
        state: schema.consumers.state,
        stateHuman: schema.consumers.stateHuman,
        stateHumanWord: schema.consumers.stateHumanWord,
    })
        .from(schema.consumers)
        .where(sql`${schema.consumers.cwd} IS NOT NULL AND ${schema.consumers.cwd} != ''`)
        .all()) {
        if (c.cwd && consumerEffectiveRunning(c.consumerId, c.stateUpdatedAt, cutoff)) {
            runningRoots.add(c.cwd);
            const prev = runningStateByRoot.get(c.cwd);
            if (!prev || c.state === "busy") {
                runningStateByRoot.set(c.cwd, {
                    state: c.state,
                    human: c.stateHuman === 1,
                    word: c.stateHumanWord,
                });
            }
        }
    }
    for (const p of byProject.values()) {
        const s = rootsByProject.get(p.name);
        if (s && s.size > 0) {
            p.local = true;
            p.roots = [...s];
            p.running = p.roots.some((r) => runningRoots.has(r));
            if (p.running) {
                const rr = p.roots.find((r) => runningStateByRoot.has(r));
                const st = rr ? runningStateByRoot.get(rr) : undefined;
                if (st) {
                    p.running_state = st.state ?? undefined;
                    p.running_human = st.human;
                    p.running_human_word = st.word ?? undefined;
                }
            }
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
 * targeting any of those ids (no FK on pings; cleanup is explicit), AND the
 * registry row itself — sans ça le projet réapparaît dans `listProjects`
 * (qui merge le registre + les projects distincts des tickets).
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
        // La ligne registre : sinon le projet (0 ticket) reste listé.
        tx.delete(schema.projects).where(eq(schema.projects.name, name)).run();
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

    // Token effort (#406, suite #404). Project-wide raw sums (null until any
    // usage is captured) + the costliest tickets. Raw counts only — the UI
    // derives the cost-equivalent (cache_r weighted 0.1×, see #404 findings).
    token_usage: TokenTally | null;
    top_token_tickets: { id: number; title: string; token_usage: TokenTally }[];
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

    // ---- Token effort (#406, suite #404) ----
    // The headline UI metric is `estTokenEffort` (in + cache_w + out, NO
    // cache_r) — david `#446` switched the UI off the cost-equivalent
    // weighting because re-reading the same context each turn cumulated
    // cache_r and inflated the displayed total ("cumule le cumul"). The
    // SORT key here must match what the UI shows ; otherwise the bars
    // are rendered in the order of cost-equivalent (cache_r-heavy) but
    // labelled with effort, and a high-effort/low-cache-read ticket
    // surfaces at the bottom of the supposed "Top 3" — david `#466`.
    // Same formula as frontend/src/lib/format.ts::estTokenEffort.
    const tokenMap = getTicketTokenUsage(ticketIds);
    const tokEffort = (u: TokenTally) => u.tokens_in + u.cache_w + u.tokens_out;
    const tokTitleById = new Map(tickets.map((t) => [t.id, t.editedTitle ?? t.title ?? ""]));
    const tokTotal: TokenTally = { tokens_in: 0, tokens_out: 0, cache_w: 0, cache_r: 0, updated_at: "" };
    const tokRows: { id: number; title: string; token_usage: TokenTally }[] = [];
    for (const [id, u] of tokenMap) {
        tokTotal.tokens_in += u.tokens_in;
        tokTotal.tokens_out += u.tokens_out;
        tokTotal.cache_w += u.cache_w;
        tokTotal.cache_r += u.cache_r;
        if (u.updated_at > tokTotal.updated_at) tokTotal.updated_at = u.updated_at;
        tokRows.push({ id, title: tokTitleById.get(id) ?? "", token_usage: u });
    }
    tokRows.sort((a, b) => tokEffort(b.token_usage) - tokEffort(a.token_usage));
    // #406 david `3q954y` : "le top 3 des tickets les plus couteux".
    const topTokenTickets = tokRows.slice(0, 3);
    const tokenUsageTotal = tokenMap.size > 0 ? tokTotal : null;

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
        token_usage: tokenUsageTotal,
        top_token_tickets: topTokenTickets,
    };
}

/**
 * Per-ticket actionable set (#B.232 #234 david). Mirrors the
 * actionable_count gating already computed inside `listProjectsDetailed`
 * but exposes the SET of ticket ids instead of per-project counts, so
 * the /api/tickets endpoint and the MCP `ticket_list` tool can filter
 * the result list on the same semantic as the sidebar badge.
 *
 * A ticket is actionable when it is:
 *   - approved (passed moderation)
 *   - NOT closed (no approved ticket_closed without a later ticket_reopened)
 *   - NOT snoozed (postponed_until in the future)
 *   - NOT resolved (no pending/approved ticket_resolved row AND no
 *     comment_added carrying meta.decision.kind="resolution" in
 *     pending/accepted status)
 *   - NOT blocked (no pending/approved ticket_blocked)
 *   - NOT gated by an active depends_on / blocks relation to an open
 *     blocker (#B.123 phase B.4)
 *
 * Returns both sets so callers can distinguish "open but not actionable"
 * (e.g. a pending resolution-proposal awaiting reporter accept) from
 * "fully closed". `openIds` ⊇ `actionableIds`.
 *
 * Logic intentionally duplicates the relevant chunk of
 * `listProjectsDetailed` rather than refactoring it — the original
 * function is load-bearing for the sidebar and a split would touch too
 * many call sites for this slice. Divergence risk is small (the
 * lifecycle rules are stable) and tests cover the count path.
 */
export interface ActionableTicketSet {
    /** All open ticket ids regardless of resolution/blocked/gated state. */
    openIds: Set<number>;
    /** Subset of openIds that pass every actionable gate. */
    actionableIds: Set<number>;
}

/**
 * #374: tickets where a counterpart (some actor other than `consumerId`) has
 * acted — i.e. `consumerId` is NOT the sole participant. An "action" is a
 * comment / lifecycle event author or a decision decider; structural events
 * (relation / sub_added / referenced) and the `auto` moderation marker don't
 * count (see docs/TICKET_LIFECYCLE.md §4.2). Used to tell apart "I replied,
 * awaiting you" (counterpart exists → gate me out) from "my own untouched
 * task" (sole participant → keep it actionable, the #370 backlog case).
 */
function foreignActorTickets(consumerId: string): Set<number> {
    const db = getDb();
    const out = new Set<number>();
    for (const t of db.select({
        id: schema.tickets.id,
        byAgent: schema.tickets.byAgent,
    }).from(schema.tickets).all()) {
        if (isForeignActor(t.byAgent, consumerId)) out.add(t.id);
    }
    for (const m of db.select({
        ticketId: schema.messages.ticketId,
        byAgent: schema.messages.byAgent,
        kind: schema.messages.kind,
        status: schema.messages.status,
        meta: schema.messages.meta,
    }).from(schema.messages).where(eq(schema.messages.status, "approved")).all()) {
        if (m.ticketId == null) continue;
        let decisionStatus: string | null = null;
        let decidedBy: string | null = null;
        if (m.meta) {
            try {
                const d = (JSON.parse(m.meta) as { decision?: { status?: string; decided_by?: string } }).decision;
                if (d) { decisionStatus = d.status ?? null; decidedBy = d.decided_by ?? null; }
            } catch { /* malformed meta — skip */ }
        }
        if (eventHasForeignActor({ kind: m.kind, byAgent: m.byAgent, decisionStatus, decidedBy }, consumerId)) {
            out.add(m.ticketId);
        }
    }
    return out;
}

/**
 * #374: per-consumer "whose court" exclusion set — replaces the comment-only
 * `lastNonLifecycleAuthorByTicket` (#265). A ticket is excluded from C's
 * actionable pool iff **C took the last action AND a counterpart exists**:
 *
 *   exclude  ⟺  ticket.last_actor === C  AND  C is not the sole participant.
 *
 * Reads the denormalized `tickets.last_actor` (maintained at every action
 * chokepoint, #374) — so a human reopen / accept / close now correctly hands
 * the ball back to the agent (fixes #305, which the old comment-only heuristic
 * missed). When C is the sole participant (their own un-answered task), the
 * ticket stays actionable — the #370 backlog case.
 */
export function lastActorExclusions(consumerId: string): Set<number> {
    const db = getDb();
    const rows = db.select({
        id: schema.tickets.id,
        lastActor: schema.tickets.lastActor,
    }).from(schema.tickets).all();
    const hasForeign = foreignActorTickets(consumerId);
    const out = new Set<number>();
    for (const r of rows) {
        if (isExcludedForConsumer(r.lastActor, hasForeign.has(r.id), consumerId)) out.add(r.id);
    }
    return out;
}

/**
 * Per-ticket actionable gate driven by the LATEST decision signal (#273).
 * Walks every gate-relevant message — legacy `ticket_resolved` /
 * `ticket_reopened` lifecycle rows AND decision-on-comment
 * (`meta.decision`) — in id order and keeps the LAST signal per ticket
 * ("latest decision wins", the backend mirror of the frontend
 * `findActiveDecision`).
 *
 * Replaces the previous monotonic behaviour (#B.242) where ANY pending
 * decision set the gate forever: a stale older `resolution:pending` then
 * kept a ticket out of actionable even after the reporter accepted a
 * NEWER plan. With latest-wins, an accepted plan (the GO-signal) un-gates
 * the ticket because it is the most recent decision, regardless of older
 * dangling proposals.
 *
 * Signal per message (last in id order wins):
 *   - ticket_reopened (approved)                          → UNGATE
 *   - ticket_resolved (approved|pending)                  → GATE
 *   - resolution:pending | resolution:accepted            → GATE
 *   - plan:pending                                        → GATE
 *   - resolution:rejected | plan:accepted | plan:rejected → UNGATE
 * Everything else carries no signal (skipped).
 *
 * `accepted` resolution still gates (short window before close);
 * `accepted` plan is the GO-signal so it un-gates for the agent to execute.
 */
export function decisionGateByTicket(): Map<number, boolean> {
    const db = getDb();
    const rows = db.select({
        ticketId: schema.messages.ticketId,
        kind: schema.messages.kind,
        status: schema.messages.status,
        meta: schema.messages.meta,
        byAgent: schema.messages.byAgent,
    })
        .from(schema.messages)
        .where(inArray(schema.messages.kind, ["ticket_resolved", "ticket_reopened", "comment_added"]))
        .orderBy(asc(schema.messages.id))
        .all();
    // #358 : la logique de rejeu vit dans decision-gate.ts (pure, testée). On
    // bâtit le set humain une fois pour que le yield-sur-commentaire ne tape
    // pas la table consumers à chaque ligne.
    const humans = new Set(listHumans());
    return computeDecisionGate(rows, (id) => humans.has(id));
}

export function computeActionableTicketIds(consumerId?: string): ActionableTicketSet {
    const db = getDb();
    const nowStr = nowIso();

    // Lifecycle replay (mirrors listProjectsDetailed lines 201-249).
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
    // #273: latest-decision-wins gate (legacy ticket_resolved/reopened +
    // decision-on-comment, last signal per ticket). Replaces the old
    // monotonic gate that the lifecycle loop + decision block used to set.
    const gatedByDecisionByTicket = decisionGateByTicket();
    const blockedByTicket = new Map<number, boolean>();
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") {
            if (ev.status === "approved") closedByTicket.set(ev.ticket_id, true);
        } else if (ev.kind === "ticket_reopened") {
            if (ev.status === "approved") {
                closedByTicket.set(ev.ticket_id, false);
                blockedByTicket.set(ev.ticket_id, false);
            }
        } else if (ev.kind === "ticket_blocked") {
            if (ev.status === "approved" || ev.status === "pending") {
                blockedByTicket.set(ev.ticket_id, true);
            }
        }
    }

    // Open set: approved + not lifecycle-closed + not snoozed.
    const tickets = db.select({
        id: schema.tickets.id,
        project: schema.tickets.project,
        status: schema.tickets.status,
        postponedUntil: schema.tickets.postponedUntil,
        assignee: schema.tickets.assignee,
        assignedAt: schema.tickets.assignedAt,
        claimant: schema.tickets.claimant,
        claimedAt: schema.tickets.claimedAt,
    }).from(schema.tickets).all();
    const openIds = new Set<number>();
    for (const t of tickets) {
        if (t.status !== "approved") continue;
        if (closedByTicket.get(t.id) === true) continue;
        if (t.postponedUntil && t.postponedUntil > nowStr) continue;
        openIds.add(t.id);
    }

    // #418/#436: anti-collision exclusion — a ticket HELD by someone OTHER than
    // the requesting consumer leaves THEIR actionable pool. Held = a LIVE claim
    // by another agent (transient focus lock) OR an assignment to another
    // consumer (persistent responsibility). It stays `open` (still a real
    // ticket); only `actionable` narrows. Unheld / held-by-me / an expired claim
    // with no assignment → falls through to the last_actor gate (the shared pool).
    // Only computed when a consumer is in scope (anonymous callers see the pool).
    const assignedAwaySet = new Set<number>();
    if (consumerId) {
        const nowMs = Date.now();
        const assignWindowMs = assignWindowSec() * 1000;
        for (const t of tickets) {
            if (isHeldByOther(t.assignee, t.claimant, t.claimedAt, consumerId, nowMs, assignWindowMs)) {
                assignedAwaySet.add(t.id);
            }
        }
    }

    // Relation gating: depends_on / blocks chains to an open blocker
    // suppress the dependent from the actionable set (#B.123 phase B.4).
    const latestRelations = db.select({
        sourceTicketId: schema.messages.ticketId,
        targetTicketId: schema.messages.sourceTicketId,
        meta: schema.messages.meta,
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
        if (r.kind === "depends_on" && openIds.has(r.target)) gatedByBlocker.add(r.source);
        else if (r.kind === "blocks" && openIds.has(r.source)) gatedByBlocker.add(r.target);
    }

    // #265/#374: per-consumer "I acted last → awaiting someone else" gate,
    // now driven by `last_actor` + sole-participant (a human reopen/accept/
    // close hands the ball back — #305; an own untouched task stays mine —
    // #370). Only computed when a consumer is in scope (anonymous / token-
    // less callers keep the global, pre-#265 behaviour — zero regression).
    const awaitingOtherSet = consumerId ? lastActorExclusions(consumerId) : null;

    const actionableIds = new Set<number>();
    for (const id of openIds) {
        if (gatedByDecisionByTicket.get(id) === true) continue;
        if (blockedByTicket.get(id) === true) continue;
        if (gatedByBlocker.has(id)) continue;
        if (assignedAwaySet.has(id)) continue;
        if (awaitingOtherSet && awaitingOtherSet.has(id)) continue;
        actionableIds.add(id);
    }

    // #447: per-agent work filters — narrow the actionable pool by tag (e.g. the
    // aiball-windows agent only works `win`-tagged tickets). Server-side so it
    // applies to engage/actionable regardless of which machine the loop runs on
    // (rules live in the daemon DB, shared by every loop hitting it). Only runs
    // for a named consumer that actually HAS enabled filters → zero cost on the
    // common path; openIds (the human's view) is never narrowed. Read is
    // fail-open (no filters on error → don't hide work).
    if (consumerId) {
        const workFilters = getEnabledWorkFiltersForConsumer(consumerId);
        if (workFilters.length > 0) {
            const ids = [...actionableIds];
            const tagsById = tagsForMessages(ids);
            const projectById = new Map(tickets.map((t) => [t.id, t.project]));
            for (const id of ids) {
                const proj = projectById.get(id) ?? "";
                const tagNames = (tagsById.get(id) ?? []).map((tg) => tg.name);
                if (!ticketPassesWorkFilters(proj, tagNames, workFilters)) {
                    actionableIds.delete(id);
                }
            }
        }
    }

    return { openIds, actionableIds };
}
