/**
 * #2910 — milestones: a release of a project, and the tickets it contains.
 *
 * A milestone is a ticket of level `milestone` (the level #2241 introduced for
 * the cto agent). A ticket belongs to at most one, through `tickets.milestone_id`
 * (a column rather than a `child_of` relation: one milestone per ticket by
 * construction, and a backlog can sort on it in one query). Releasing it is
 * closing it, which is refused while any ticket in it is still open: each has
 * to be moved to another milestone or closed first, so nothing drops silently.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

export interface MilestoneRef {
    id: number;
    title: string;
    /** Closed = released. */
    released: boolean;
}

export interface MilestoneProgress {
    done: number;
    open: number;
    tickets: { id: number; title: string; closed: boolean }[];
}

export interface MilestoneRow extends MilestoneRef, Omit<MilestoneProgress, "tickets"> {
    /** When it was closed (released); null while open. */
    released_at: string | null;
    created_at: string;
}

/** The ticket ids of `ids` whose latest close/reopen is a close. */
export function closedAmong(ids: readonly number[]): Set<number> {
    const out = new Set<number>();
    if (ids.length === 0) return out;
    const events = getDb().select({ ticketId: schema.messages.ticketId, kind: schema.messages.kind })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
            inArray(schema.messages.ticketId, [...ids]),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    for (const ev of events) {
        if (ev.ticketId == null) continue;
        if (ev.kind === "ticket_closed") out.add(ev.ticketId);
        else out.delete(ev.ticketId);
    }
    return out;
}

/** When each of `ids` was last closed, for those that are closed. */
function closedAtOf(ids: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const events = getDb().select({ ticketId: schema.messages.ticketId, kind: schema.messages.kind, at: schema.messages.createdAt })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
            inArray(schema.messages.ticketId, [...ids]),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    for (const ev of events) {
        if (ev.ticketId == null) continue;
        if (ev.kind === "ticket_closed") out.set(ev.ticketId, ev.at);
        else out.delete(ev.ticketId);
    }
    return out;
}

/** The milestone each of `ticketIds` belongs to, when it belongs to one. */
export function milestonesOf(ticketIds: readonly number[]): Map<number, MilestoneRef> {
    const out = new Map<number, MilestoneRef>();
    if (ticketIds.length === 0) return out;
    const rows = getDb().select({ id: schema.tickets.id, milestoneId: schema.tickets.milestoneId })
        .from(schema.tickets)
        .where(inArray(schema.tickets.id, [...ticketIds]))
        .all()
        .filter((r) => r.milestoneId != null);
    const mIds = [...new Set(rows.map((r) => r.milestoneId!))];
    if (mIds.length === 0) return out;
    const titles = new Map(getDb().select({ id: schema.tickets.id, title: schema.tickets.title })
        .from(schema.tickets).where(inArray(schema.tickets.id, mIds)).all()
        .map((m) => [m.id, m.title ?? ""] as const));
    const released = closedAmong(mIds);
    for (const r of rows) {
        const m = r.milestoneId!;
        out.set(r.id, { id: m, title: titles.get(m) ?? "", released: released.has(m) });
    }
    return out;
}

/** The tickets in a milestone, done first-seen order by id, with the counts. */
export function milestoneProgress(milestoneId: number): MilestoneProgress {
    const members = getDb().select({ id: schema.tickets.id, title: schema.tickets.title })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.milestoneId, milestoneId), eq(schema.tickets.status, "approved")))
        .orderBy(asc(schema.tickets.id))
        .all();
    const closed = closedAmong(members.map((m) => m.id));
    const tickets = members.map((m) => ({ id: m.id, title: m.title ?? "", closed: closed.has(m.id) }));
    const done = tickets.filter((t) => t.closed).length;
    return { done, open: tickets.length - done, tickets };
}

/** The open tickets still in a milestone: what blocks releasing it. */
export function openTicketsIn(milestoneId: number): number[] {
    return milestoneProgress(milestoneId).tickets.filter((t) => !t.closed).map((t) => t.id);
}

/** The refusal for releasing a milestone that still holds open tickets. */
export function milestoneOpenRefusal(milestoneId: number, open: readonly number[]): string {
    const shown = open.slice(0, 10).map((id) => `#${id}`).join(", ");
    const more = open.length > 10 ? ` and ${open.length - 10} more` : "";
    return `milestone #${milestoneId} still holds ${open.length} open ticket${open.length > 1 ? "s" : ""} (${shown}${more}): move each to another milestone or close it, then release. Nothing was closed.`;
}

/**
 * #2910 — where a ticket's milestone puts it in the work order, lower first: the
 * project's oldest open milestone (0), then no milestone (1), then the later
 * open milestones (2, 3…). A released milestone counts as none.
 */
export function milestoneRankOf(): (project: string, milestoneId: number | null | undefined) => number {
    const byProject = new Map<string, Map<number, number>>();
    const order = (project: string): Map<number, number> => {
        let m = byProject.get(project);
        if (!m) {
            const ms = getDb().select({ id: schema.tickets.id })
                .from(schema.tickets)
                .where(and(eq(schema.tickets.project, project), eq(schema.tickets.level, "milestone"), eq(schema.tickets.status, "approved")))
                .orderBy(asc(schema.tickets.createdAt), asc(schema.tickets.id))
                .all().map((r) => r.id);
            const released = closedAmong(ms);
            m = new Map(ms.filter((id) => !released.has(id)).map((id, i) => [id, i] as const));
            byProject.set(project, m);
        }
        return m;
    };
    return (project, milestoneId) => {
        if (milestoneId == null) return 1;
        const i = order(project).get(milestoneId);
        if (i === undefined) return 1;
        return i === 0 ? 0 : i + 1;
    };
}

/** A project's milestones, oldest first, with their state and progress. */
export function listMilestones(project: string): MilestoneRow[] {
    const ms = getDb().select({ id: schema.tickets.id, title: schema.tickets.title, createdAt: schema.tickets.createdAt })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.project, project), eq(schema.tickets.level, "milestone"), eq(schema.tickets.status, "approved")))
        .orderBy(asc(schema.tickets.createdAt), asc(schema.tickets.id))
        .all();
    const closedAt = closedAtOf(ms.map((m) => m.id));
    return ms.map((m) => {
        const p = milestoneProgress(m.id);
        return {
            id: m.id,
            title: m.title ?? "",
            released: closedAt.has(m.id),
            released_at: closedAt.get(m.id) ?? null,
            created_at: m.createdAt,
            done: p.done,
            open: p.open,
        };
    });
}

/**
 * Why `milestoneId` cannot hold `ticket`, or null when it can. `milestoneId`
 * null (leaving any milestone) is always possible.
 */
export function milestoneTargetRefusal(
    ticket: { id: number; project: string; level?: string | null },
    milestoneId: number | null,
): string | null {
    if (milestoneId === null) return null;
    if ((ticket.level ?? "task") === "milestone") return `#${ticket.id} is itself a milestone: a milestone does not belong to another`;
    const m = getDb().select({ id: schema.tickets.id, project: schema.tickets.project, level: schema.tickets.level, status: schema.tickets.status })
        .from(schema.tickets).where(eq(schema.tickets.id, milestoneId)).get();
    if (!m || m.status !== "approved") return `#${milestoneId} is not a ticket of this board`;
    if (m.level !== "milestone") return `#${milestoneId} is not a milestone (its level is ${m.level})`;
    if (m.project !== ticket.project) return `#${milestoneId} is a milestone of ${m.project}; #${ticket.id} is in ${ticket.project}`;
    if (closedAmong([milestoneId]).has(milestoneId)) return `milestone #${milestoneId} is already released (closed)`;
    return null;
}

export function setTicketMilestone(ticketId: number, milestoneId: number | null): void {
    getDb().update(schema.tickets).set({ milestoneId }).where(eq(schema.tickets.id, ticketId)).run();
}
