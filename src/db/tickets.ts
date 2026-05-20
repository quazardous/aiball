/**
 * Ticket-level state mutators that don't belong to the message lifecycle —
 * specifically broadcast (#B.72) and snooze / postpone (#B.329). These
 * fields live on the `tickets` row directly (not as separate events) so
 * the writes are simple updates.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";

// =====================================================================
//  Sub-tickets (per #B.62 follow-up)
// =====================================================================

/**
 * Lightweight summary of a sub-ticket, used by the thread API to render
 * a recap of children in the parent's header. Excludes rejected
 * children so they don't pollute the parent's view.
 */
export interface SubTicketSummary {
    id: number;
    title: string;
    status: "pending" | "approved" | "rejected";
    closed: boolean;
    /** Lifecycle stage (open / closed / resolved / snoozed / …). */
    stage: TicketStage;
}

/**
 * Six-way enum describing a ticket's currently-displayed state, suitable
 * for a small visual badge. Computed via lifecycle replay + status +
 * postpone deadline.
 */
export type TicketStage =
    | "rejected"
    | "closed-resolved"
    | "closed"
    | "resolved"
    | "blocked"
    | "snoozed"
    | "pending"
    | "open";

/**
 * Compute the lifecycle stage of a set of tickets in one DB roundtrip
 * per kind of state — used by the thread API to enrich
 * ticket_referenced / ticket_sub_added pseudo-comments with the target
 * ticket's current stage (per #B.70 follow-up).
 */
export function getTicketStages(ids: number[]): Map<number, TicketStage> {
    const out = new Map<number, TicketStage>();
    if (ids.length === 0) return out;
    const db = getDb();
    const rows = db.select({
        id: schema.tickets.id,
        status: schema.tickets.status,
        postponedUntil: schema.tickets.postponedUntil,
    }).from(schema.tickets).where(inArray(schema.tickets.id, ids)).all();
    const events = db.select({
        ticket_id: schema.messages.ticketId,
        kind: schema.messages.kind,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.status, "approved"),
            inArray(schema.messages.ticketId, ids),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    const closedById = new Map<number, boolean>();
    const resolvedById = new Map<number, boolean>();
    const blockedById = new Map<number, boolean>();
    for (const ev of events) {
        if (ev.kind === "ticket_closed") closedById.set(ev.ticket_id, true);
        else if (ev.kind === "ticket_reopened") {
            closedById.set(ev.ticket_id, false);
            resolvedById.set(ev.ticket_id, false);
            blockedById.set(ev.ticket_id, false);
        } else if (ev.kind === "ticket_resolved") resolvedById.set(ev.ticket_id, true);
        else if (ev.kind === "ticket_blocked") blockedById.set(ev.ticket_id, true);
    }
    // #B.129 phase 2: layer decision-on-comment "resolution"-accepted
    // comments on top. Same semantic as legacy ticket_resolved.
    const decisionComments = db.select({
        ticket_id: schema.messages.ticketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.status, "approved"),
            eq(schema.messages.kind, "comment_added"),
            inArray(schema.messages.ticketId, ids),
        ))
        .all();
    for (const c of decisionComments) {
        if (!c.meta) continue;
        try {
            const m = JSON.parse(c.meta) as { decision?: { kind?: string; status?: string } };
            if (m.decision?.kind === "resolution" && m.decision.status === "accepted") {
                resolvedById.set(c.ticket_id, true);
            }
        } catch { /* malformed meta, skip */ }
    }
    const nowStr = nowIso();
    for (const r of rows) {
        const closed = closedById.get(r.id) === true;
        const resolved = resolvedById.get(r.id) === true;
        const blocked = blockedById.get(r.id) === true;
        if (r.status === "rejected") {
            out.set(r.id, "rejected");
        } else if (closed && resolved) {
            out.set(r.id, "closed-resolved");
        } else if (closed) {
            out.set(r.id, "closed");
        } else if (resolved) {
            out.set(r.id, "resolved");
        } else if (blocked) {
            out.set(r.id, "blocked");
        } else if (r.postponedUntil && r.postponedUntil > nowStr) {
            out.set(r.id, "snoozed");
        } else if (r.status === "pending") {
            out.set(r.id, "pending");
        } else {
            out.set(r.id, "open");
        }
    }
    // Tickets we couldn't find at all (deleted etc.) get "open" as a
    // safe default — keeps the frontend rendering consistent.
    for (const id of ids) if (!out.has(id)) out.set(id, "open");
    return out;
}

/**
 * Bookends of a scope — first (oldest) and last (most recent) ticket
 * matching the filters. Used by the slim `poll()` (per #B.68) so agents
 * see the inbox edges without paying for the whole sub list.
 *
 * Ordering is by `id` (chronological by creation, since ticket ids are
 * dense post-migration 0007). Rejected tickets are filtered out — they
 * don't belong on either end of an "active" inbox view.
 */
export interface TicketBookend {
    id: number;
    project: string;
    title: string;
    by_agent: string | null;
    created_at: string;
    intent: string | null;
}

export function getTicketBookends(opts: {
    project?: string;
    includeSnoozed?: boolean;
}): { first: TicketBookend | null; last: TicketBookend | null } {
    const db = getDb();
    // Build the WHERE: not-rejected + optional project filter. Snooze
    // filter happens in JS to keep the SQL straightforward (no need to
    // express "postponed_until > now" via Drizzle).
    const baseConds = [ne(schema.tickets.status, "rejected")];
    if (opts.project) baseConds.push(eq(schema.tickets.project, opts.project));
    const rows = db.select({
        id: schema.tickets.id,
        project: schema.tickets.project,
        title: schema.tickets.title,
        editedTitle: schema.tickets.editedTitle,
        byAgent: schema.tickets.byAgent,
        createdAt: schema.tickets.createdAt,
        intent: schema.tickets.intent,
        postponedUntil: schema.tickets.postponedUntil,
    })
        .from(schema.tickets)
        .where(and(...baseConds))
        .all();
    const nowStr = nowIso();
    const filtered = rows.filter((r) => {
        if (!opts.includeSnoozed && r.postponedUntil && r.postponedUntil > nowStr) return false;
        return true;
    });
    if (filtered.length === 0) return { first: null, last: null };
    filtered.sort((a, b) => a.id - b.id);
    const toBookend = (r: typeof filtered[number]): TicketBookend => ({
        id: r.id,
        project: r.project,
        title: r.editedTitle ?? r.title ?? "",
        by_agent: r.byAgent,
        created_at: r.createdAt,
        intent: r.intent,
    });
    return {
        first: toBookend(filtered[0]),
        last: toBookend(filtered[filtered.length - 1]),
    };
}

/**
 * List direct children of a ticket (rows with parent_ticket_id = parentId),
 * with their lifecycle-derived `closed` flag. Rejected children are
 * filtered out. Ordered by id ASC (chronological).
 */
export function listSubTickets(parentId: number): SubTicketSummary[] {
    const db = getDb();
    const rows = db.select({
        id: schema.tickets.id,
        title: schema.tickets.title,
        editedTitle: schema.tickets.editedTitle,
        status: schema.tickets.status,
    })
        .from(schema.tickets)
        .where(eq(schema.tickets.parentTicketId, parentId))
        .orderBy(asc(schema.tickets.id))
        .all();
    if (rows.length === 0) return [];
    const filtered = rows.filter((r) => r.status !== "rejected");
    const stages = getTicketStages(filtered.map((r) => r.id));
    return filtered.map((r) => {
        const stage = stages.get(r.id) ?? "open";
        return {
            id: r.id,
            title: r.editedTitle ?? r.title ?? "(no title)",
            status: r.status as "pending" | "approved" | "rejected",
            closed: stage === "closed" || stage === "closed-resolved",
            stage,
        };
    });
}

/**
 * Count direct children per parent ticket, in one shot. Rejected children
 * are excluded (symmetric with listSubTickets). Used by the ticket list
 * endpoint to surface lineage without paying a per-row N+1.
 */
export function subTicketCounts(parentIds: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (parentIds.length === 0) return out;
    const rows = getDb().select({
        parentId: schema.tickets.parentTicketId,
        count: sql<number>`COUNT(*)`,
    })
        .from(schema.tickets)
        .where(and(
            inArray(schema.tickets.parentTicketId, parentIds),
            ne(schema.tickets.status, "rejected"),
        ))
        .groupBy(schema.tickets.parentTicketId)
        .all();
    for (const r of rows) {
        if (r.parentId !== null) out.set(r.parentId, Number(r.count));
    }
    return out;
}

// =====================================================================
//  Broadcast (#B.72)
// =====================================================================

/**
 * Read the scope of a ticket. Returns 'default' for missing rows
 * (#B.245 tristate). The fan-out only treats `scope === 'broadcast'`
 * as the trigger for follower delivery; `internal` keeps the ticket
 * out of even the owner default path.
 */
export function getTicketScope(ticketId: number): "internal" | "default" | "broadcast" {
    const row = getDb().select({ scope: schema.tickets.scope })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    return (row?.scope as "internal" | "default" | "broadcast" | undefined) ?? "default";
}

// =====================================================================
//  Postpone / snooze (#B.329)
// =====================================================================

/**
 * Snooze a ticket until the given ISO8601 timestamp. While the ticket is
 * snoozed, it's hidden from the open inbox (treated as closed for
 * filtering). The daemon's reveal cron clears the field at the deadline
 * and broadcasts a `message_edited` so the ticket bounces back into the
 * inbox.
 */
export function setTicketPostpone(ticketId: number, until: string | null): boolean {
    const res = getDb().update(schema.tickets)
        .set({ postponedUntil: until })
        .where(eq(schema.tickets.id, ticketId))
        .run();
    return res.changes > 0;
}

export function getTicketPostpone(ticketId: number): string | null {
    const row = getDb()
        .select({ p: schema.tickets.postponedUntil })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .get();
    return row?.p ?? null;
}

/**
 * Return the ids of tickets whose snooze period has expired (i.e.
 * `postponed_until <= now`). The caller (daemon cron) is expected to
 * clear the field for each. Cheap query — uses the
 * `idx_tickets_postponed` index.
 */
export function listExpiredPostpones(nowIsoString: string = nowIso()): number[] {
    const rows = getDb()
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(and(
            isNotNull(schema.tickets.postponedUntil),
            lte(schema.tickets.postponedUntil, nowIsoString),
        ))
        .all();
    return rows.map((r) => r.id);
}
