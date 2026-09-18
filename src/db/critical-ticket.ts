/**
 * #2770 — a project's critical ticket, read from the board: the open ticket of
 * the project that holds back the most open tickets. The tickets held may be in
 * any project — they are the ones kept waiting.
 *
 * "Open" is what the actionable gate calls a blocker: approved and not closed.
 * A snoozed ticket is asleep, not done, so it still holds and is still held.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { gateEdges, pickCritical, quietFor } from "../critical-ticket.js";

export interface CriticalTicket {
    id: number;
    title: string;
    holds: number;
    /** When it last moved (its last actor); null if never. */
    last_moved_at: string | null;
    /** `3 d` once it has been quiet a full day; "" before that. */
    quiet: string;
}

export function projectCriticalTicket(project: string, nowMs: number = Date.now()): CriticalTicket | null {
    const db = getDb();
    const rows = db.select({
        sourceTicketId: schema.messages.ticketId,
        targetTicketId: schema.messages.sourceTicketId,
        meta: schema.messages.meta,
    })
        .from(schema.messages)
        .where(and(eq(schema.messages.kind, "ticket_relation"), eq(schema.messages.status, "approved")))
        .orderBy(schema.messages.id)
        .all();
    const edges = gateEdges(rows);
    if (edges.length === 0) return null;
    const ids = [...new Set(edges.flatMap((e) => [e.waiter, e.blocker]))];

    const tickets = db.select({
        id: schema.tickets.id,
        project: schema.tickets.project,
        status: schema.tickets.status,
        title: schema.tickets.title,
        lastActorAt: schema.tickets.lastActorAt,
        createdAt: schema.tickets.createdAt,
    }).from(schema.tickets).where(inArray(schema.tickets.id, ids)).all();
    const byId = new Map(tickets.map((t) => [t.id, t] as const));

    const closed = new Map<number, boolean>();
    const lifecycle = db.select({ ticketId: schema.messages.ticketId, kind: schema.messages.kind })
        .from(schema.messages)
        .where(and(
            inArray(schema.messages.kind, ["ticket_closed", "ticket_reopened"]),
            eq(schema.messages.status, "approved"),
            inArray(schema.messages.ticketId, ids),
        ))
        .orderBy(asc(schema.messages.id))
        .all();
    for (const ev of lifecycle) closed.set(ev.ticketId, ev.kind === "ticket_closed");

    const movedMs = (id: number): number => {
        const t = byId.get(id);
        const ms = Date.parse(t?.lastActorAt ?? t?.createdAt ?? "");
        return Number.isFinite(ms) ? ms : 0;
    };
    const pick = pickCritical(
        edges,
        (id) => byId.get(id)?.status === "approved" && closed.get(id) !== true,
        (id) => byId.get(id)?.project === project,
        movedMs,
    );
    if (!pick) return null;
    const t = byId.get(pick.id)!;
    return {
        id: pick.id,
        title: t.title ?? "",
        holds: pick.holds,
        last_moved_at: t.lastActorAt ?? null,
        quiet: quietFor(movedMs(pick.id), nowMs),
    };
}
