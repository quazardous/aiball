/**
 * #2770 — a project's critical ticket, read from the board: the open ticket of
 * the project that holds back the most open tickets. The tickets held may be in
 * any project — they are the ones kept waiting.
 *
 * "Open" is what the actionable gate calls a blocker: approved and not closed.
 * A snoozed ticket is asleep, not done, so it still holds and is still held.
 *
 * #3383 — kept until a ticket changes: it reads every relation of the board,
 * and each backlog read asked for it again (a third of a warm read). The board
 * is read once for all the projects (the inbox asks for each of them after
 * every write), and a project's pick is computed from it on demand. Only
 * `quiet` depends on the clock, and is computed at each read.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { gateEdges, pickCritical, quietFor, type GateEdge } from "../critical-ticket.js";
import { onTicketChanged } from "./ticket-change.js";

export interface CriticalTicket {
    id: number;
    title: string;
    holds: number;
    /** When it last moved (its last actor); null if never. */
    last_moved_at: string | null;
    /** `3 d` once it has been quiet a full day; "" before that. */
    quiet: string;
}

/** A project's pick without its clock-dependent part, and when it last moved. */
type Kept = { pick: Omit<CriticalTicket, "quiet">; movedMs: number } | null;

/** The board's gates and the tickets they join: what every project's pick is computed from. */
interface Board {
    edges: GateEdge[];
    byId: Map<number, { project: string; status: string; title: string | null; lastActorAt: string | null; createdAt: string }>;
    closed: Map<number, boolean>;
    picks: Map<string, Kept>;
    until: number;
}

/** The net for a write that does not say `ticketChanged` (a title edited in place). */
const CEILING_MS = 60_000;
let board: Board | null = null;
onTicketChanged(() => { board = null; });

/** Tests — force a cold cache. */
export function resetCriticalTicketCacheForTests(): void {
    board = null;
}

export function projectCriticalTicket(project: string, nowMs: number = Date.now()): CriticalTicket | null {
    if (!board || nowMs >= board.until) board = readBoard(nowMs + CEILING_MS);
    let kept = board.picks.get(project);
    if (kept === undefined) {
        kept = pickFor(board, project);
        board.picks.set(project, kept);
    }
    return kept ? { ...kept.pick, quiet: quietFor(kept.movedMs, nowMs) } : null;
}

function readBoard(until: number): Board {
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
    const closed = new Map<number, boolean>();
    if (edges.length === 0) return { edges, byId: new Map(), closed, picks: new Map(), until };
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
    return { edges, byId, closed, picks: new Map(), until };
}

function pickFor({ edges, byId, closed }: Board, project: string): Kept {
    if (edges.length === 0) return null;
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
        pick: { id: pick.id, title: t.title ?? "", holds: pick.holds, last_moved_at: t.lastActorAt ?? null },
        movedMs: movedMs(pick.id),
    };
}
