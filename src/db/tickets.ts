/**
 * Ticket-level state mutators that don't belong to the message lifecycle —
 * specifically broadcast (#B.72) and snooze / postpone (#B.329). These
 * fields live on the `tickets` row directly (not as separate events) so
 * the writes are simple updates.
 *
 * Extracted from db.ts (#B.332 Phase A.2).
 */
import { and, asc, eq, inArray, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb, nowIso } from "./connection.js";
import { listTypedRelationsForTicket } from "./messages.js";

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
 * List direct children of a ticket, with their lifecycle-derived `closed`
 * flag. Rejected children are filtered out. Ordered by id ASC.
 *
 * #271: lineage is read from the typed-relations graph, not the legacy
 * `parent_ticket_id` FK — the parent sees its children as reciprocal
 * `parent_of` chips (each child authored a `child_of` event). This keeps
 * the recap and the relations cartouche in sync (the bug they used to
 * drift on) and lets Phase 3 drop the FK column.
 */
export function listSubTickets(parentId: number): SubTicketSummary[] {
    const db = getDb();
    const childIds = listTypedRelationsForTicket(parentId)
        .filter((r) => r.kind === "parent_of")
        .map((r) => r.target_ticket_id);
    if (childIds.length === 0) return [];
    const rows = db.select({
        id: schema.tickets.id,
        title: schema.tickets.title,
        editedTitle: schema.tickets.editedTitle,
        status: schema.tickets.status,
    })
        .from(schema.tickets)
        .where(inArray(schema.tickets.id, childIds))
        .all();
    const filtered = rows.filter((r) => r.status !== "rejected");
    if (filtered.length === 0) return [];
    filtered.sort((a, b) => a.id - b.id);
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
 * #352: reassign a ticket's owner — which IS its `by_agent` / reporter (no
 * model change, per david). owner-bypass (close/reopen) and auto-subscribe
 * follow `by_agent`, so updating it transfers authority. The API layer gates
 * this to the human moderator and subscribes the new owner.
 */
export function setTicketOwner(ticket_id: number, by_agent: string): void {
    getDb().update(schema.tickets)
        .set({ byAgent: by_agent })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/**
 * #436: ASSIGNMENT — a human moderator pushes a RESPONSIBILITY onto a consumer.
 * Persistent (no auto-expiry); cleared on reassign/close. `assignedBy` audits
 * who set it. Distinct from a claim (see setTicketClaim).
 */
export function setTicketAssignment(
    ticket_id: number,
    assignee: string,
    assigned_by: string,
): void {
    getDb().update(schema.tickets)
        .set({ assignee, assignedBy: assigned_by, assignedAt: nowIso() })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/**
 * #436: CLAIM — an agent self-declares FOCUS ("I'm on this now"), via
 * ticket_engage or a self ticket_assign. Transient: the live window is derived
 * (`now − claimedAt < assign_window_sec`) and one-focus. Drives the work-order
 * tiebreak (#430) + token attribution (#434). Independent of any assignment.
 */
export function setTicketClaim(ticket_id: number, claimant: string, at: string = nowIso()): void {
    getDb().update(schema.tickets)
        .set({ claimant, claimedAt: at })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/**
 * #439 one-focus: every ticket this consumer currently holds a CLAIM on
 * ({id, claimed_at}). Closed/resolved tickets already have their hold cleared
 * (`releaseTicketHold` fires on close), so this surfaces only open claims —
 * liveness + comment checks are left to the pure `claimsToAutoRelease`.
 */
export function ticketsClaimedBy(consumer_id: string): { id: number; claimed_at: string }[] {
    return getDb()
        .select({ id: schema.tickets.id, claimedAt: schema.tickets.claimedAt })
        .from(schema.tickets)
        .where(and(
            eq(schema.tickets.claimant, consumer_id),
            isNotNull(schema.tickets.claimedAt),
        ))
        .all()
        .filter((r): r is { id: number; claimedAt: string } => r.claimedAt != null)
        .map((r) => ({ id: r.id, claimed_at: r.claimedAt }));
}

/** #436: release a ticket's ASSIGNMENT (responsibility) — back to the shared pool. */
export function releaseTicketAssignment(ticket_id: number): void {
    getDb().update(schema.tickets)
        .set({ assignee: null, assignedBy: null, assignedAt: null })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/** #436: release a ticket's CLAIM (focus) — drop the lock, keep any assignment. */
export function releaseTicketClaim(ticket_id: number): void {
    getDb().update(schema.tickets)
        .set({ claimant: null, claimedAt: null })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/**
 * #436: clear BOTH holds (assignment + claim). Fired on close/resolve so a later
 * reopen starts fresh. Also zeroes the vestigial `is_claim`.
 */
export function releaseTicketHold(ticket_id: number): void {
    getDb().update(schema.tickets)
        .set({ assignee: null, assignedBy: null, assignedAt: null, claimant: null, claimedAt: null, isClaim: 0 })
        .where(eq(schema.tickets.id, ticket_id))
        .run();
}

/**
 * Count direct children per parent ticket, in one shot. Rejected children
 * are excluded (symmetric with listSubTickets). Used by the ticket list
 * endpoint to surface lineage without paying a per-row N+1.
 *
 * #271: derived from the relations graph. Pull every ticket_relation
 * event authored on a child pointing at one of the parents (the child's
 * `child_of` event has sourceTicketId = parent), replay latest-per-pair,
 * keep the surviving `child_of` links, exclude rejected children.
 */
export function subTicketCounts(parentIds: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (parentIds.length === 0) return out;
    const db = getDb();
    const events = db.select({
        child: schema.messages.ticketId,
        parent: schema.messages.sourceTicketId,
        meta: schema.messages.meta,
        id: schema.messages.id,
    })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.kind, "ticket_relation"),
            eq(schema.messages.status, "approved"),
            inArray(schema.messages.sourceTicketId, parentIds),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    // Latest event wins per (parent, child) pair.
    const latest = new Map<string, { parent: number; child: number; kind: string | undefined }>();
    for (const e of events) {
        if (e.parent === null || e.child === null) continue;
        let kind: string | undefined;
        try {
            kind = (JSON.parse(e.meta ?? "{}") as { relation?: { kind?: string } }).relation?.kind;
        } catch { kind = undefined; }
        latest.set(`${e.parent}:${e.child}`, { parent: e.parent, child: e.child, kind });
    }
    const childOfPairs = Array.from(latest.values()).filter((p) => p.kind === "child_of");
    if (childOfPairs.length === 0) return out;
    const childIds = Array.from(new Set(childOfPairs.map((p) => p.child)));
    const rejected = new Set(
        db.select({ id: schema.tickets.id })
            .from(schema.tickets)
            .where(and(
                inArray(schema.tickets.id, childIds),
                eq(schema.tickets.status, "rejected"),
            ))
            .all()
            .map((r) => r.id),
    );
    for (const p of childOfPairs) {
        if (rejected.has(p.child)) continue;
        out.set(p.parent, (out.get(p.parent) ?? 0) + 1);
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

/**
 * #402 — the requesting consumer's OWN last activity per ticket: MAX(created_at)
 * over the messages THEY authored, grouped by ticket. The hot-zone primitive
 * (POV agent, david `xkehmv`): a ticket is "hot" for a consumer iff THEY acted
 * on it recently — so someone else's activity on a different ticket never pulls
 * the agent off-task. `messages.ticket_id` is non-null for every feed row
 * (comments + the ticket_created root), so one grouped MAX covers all activity.
 * Returns ISO strings; absent ticket = the consumer never acted on it.
 */
export function ticketSelfLastActivity(consumer_id: string, ticket_ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ticket_ids.length === 0) return out;
    const rows = getDb()
        .select({
            ticketId: schema.messages.ticketId,
            last: sql<string>`MAX(${schema.messages.createdAt})`,
        })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.byAgent, consumer_id),
            inArray(schema.messages.ticketId, ticket_ids),
        ))
        .groupBy(schema.messages.ticketId)
        .all();
    for (const r of rows) if (r.ticketId != null && r.last) out.set(r.ticketId, r.last);
    return out;
}

/**
 * #408 — per-ticket last activity by an AGENT (non-human) consumer. The hot-zone
 * is the AGENT's focus, NOT the viewer's: when a HUMAN (david) comments, the
 * ticket must NOT go hot (david `#408`: « c'est pas moi qui dois passer un ticket
 * en hot ») — only an agent working it does. So: MAX(created_at) per ticket over
 * messages authored by consumers whose kind is NOT `human`. Used for the hot-zone
 * (sort tiebreak + `hot` flag) instead of the requester's own activity.
 */
export function ticketAgentLastActivity(ticket_ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ticket_ids.length === 0) return out;
    const db = getDb();
    const humanIds = db.select({ id: schema.consumers.consumerId })
        .from(schema.consumers)
        .where(eq(schema.consumers.kind, "human"))
        .all()
        .map((r) => r.id);
    const conds = [inArray(schema.messages.ticketId, ticket_ids)];
    if (humanIds.length > 0) conds.push(notInArray(schema.messages.byAgent, humanIds));
    const rows = db.select({
        ticketId: schema.messages.ticketId,
        last: sql<string>`MAX(${schema.messages.createdAt})`,
    })
        .from(schema.messages)
        .where(and(...conds))
        .groupBy(schema.messages.ticketId)
        .all();
    for (const r of rows) if (r.ticketId != null && r.last) out.set(r.ticketId, r.last);
    return out;
}
