/**
 * #3811 — who waits on whom, mixing the two ways a ticket waits:
 * - `depends_on` / `blocks`: gated until the other ticket closes;
 * - a step's `resume_on: { ticket }`: asleep until the other ticket moves.
 *
 * Two tickets that wait on each other never wake: neither will move first.
 * `ticket_reply` refuses the step that would close such a cycle, and
 * `graph_audit` reports the ones already on the board.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "../schema.js";
import { listTypedRelationsForTicket } from "./messages.js";
import { closedTicketIds } from "./ticket-closed.js";
import { isStepMeta } from "../ticket-transitions.js";
import { parseMeta } from "../message-meta.js";
import { lastMoveAt } from "./last-move.js";

export type WaitKind = "depends_on" | "resume_on";

/** `waiter` does not move until `on` does (closes, for `depends_on`). */
export interface WaitEdge {
    waiter: number;
    on: number;
    kind: WaitKind;
}

/**
 * The ticket's live `resume_on` wait: its last action is a step naming another
 * ticket, and that ticket has not moved since (`lastMoveAt`). Null otherwise.
 */
export function liveResumeOn(ticketId: number): { on: number; at: string } | null {
    const db = getDb();
    const t = db.select({ lastActorAt: schema.tickets.lastActorAt }).from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId)).get();
    if (!t?.lastActorAt) return null;
    const step = db.select({ meta: schema.messages.meta }).from(schema.messages).where(and(
        eq(schema.messages.ticketId, ticketId),
        eq(schema.messages.kind, "comment_added"),
        eq(schema.messages.status, "approved"),
        eq(schema.messages.createdAt, t.lastActorAt),
    )).all().find((m) => isStepMeta(m.meta));
    const on = step ? parseMeta(step.meta).step_resume_on_ticket : undefined;
    if (!on) return null;
    // #3909 — moved, not merely re-parked by a step that delivered nothing.
    const moved = lastMoveAt(on);
    if (moved && moved > t.lastActorAt) return null;
    return { on, at: t.lastActorAt };
}

/** What an open ticket waits on now; a closed ticket waits on nothing. */
export function waitsOf(ticketId: number): WaitEdge[] {
    if (closedTicketIds([ticketId]).has(ticketId)) return [];
    const deps = listTypedRelationsForTicket(ticketId)
        .filter((r) => r.kind === "depends_on")
        .map((r) => r.target_ticket_id);
    const closed = closedTicketIds(deps);
    const out: WaitEdge[] = deps.filter((d) => !closed.has(d)).map((on) => ({ waiter: ticketId, on, kind: "depends_on" }));
    const resume = liveResumeOn(ticketId);
    if (resume) out.push({ waiter: ticketId, on: resume.on, kind: "resume_on" });
    return out;
}

/** Past this many tickets the walk stops: a wait chain that long is not one gesture. */
const WALK_MAX = 2000;

/**
 * Would `ticketId` resuming on `on` close a wait cycle? The path back, from
 * `on` to `ticketId` (each edge with its kind), or null when there is none.
 */
export function resumeWouldCycle(ticketId: number, on: number, waits: (id: number) => WaitEdge[] = waitsOf): WaitEdge[] | null {
    const via = new Map<number, WaitEdge | null>([[on, null]]);
    const queue = [on];
    while (queue.length > 0 && via.size <= WALK_MAX) {
        const cur = queue.shift()!;
        for (const e of waits(cur)) {
            if (e.on === ticketId) {
                const path = [e];
                for (let back = via.get(cur); back; back = via.get(back.waiter)) path.unshift(back);
                return path;
            }
            if (via.has(e.on)) continue;
            via.set(e.on, e);
            queue.push(e.on);
        }
    }
    return null;
}

/** `#a →(kind) #b →(kind) #c`, for a refusal or a finding. */
export function describeWaits(edges: readonly WaitEdge[]): string {
    if (edges.length === 0) return "";
    return `#${edges[0].waiter}` + edges.map((e) => ` →${e.kind} #${e.on}`).join("");
}

/**
 * The wait cycles among `ids` and what they wait on, each once: the strongly
 * connected parts of the wait graph with more than one ticket. Each cycle
 * comes with the edges inside it.
 */
export function waitCycles(ids: readonly number[], waits: (id: number) => WaitEdge[] = waitsOf): Array<{ ids: number[]; edges: WaitEdge[] }> {
    const edgesOf = new Map<number, WaitEdge[]>();
    const out = (id: number) => {
        if (!edgesOf.has(id)) edgesOf.set(id, waits(id));
        return edgesOf.get(id)!;
    };
    // Tarjan, iterative: a long chain must not blow the stack.
    let counter = 0;
    const index = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    const found: Array<{ ids: number[]; edges: WaitEdge[] }> = [];
    for (const root of ids) {
        if (index.has(root)) continue;
        const work: Array<{ id: number; next: number }> = [{ id: root, next: 0 }];
        index.set(root, counter); low.set(root, counter); counter++;
        stack.push(root); onStack.add(root);
        while (work.length > 0) {
            const frame = work[work.length - 1];
            const edges = out(frame.id);
            if (frame.next < edges.length) {
                const w = edges[frame.next++].on;
                if (!index.has(w)) {
                    index.set(w, counter); low.set(w, counter); counter++;
                    stack.push(w); onStack.add(w);
                    work.push({ id: w, next: 0 });
                } else if (onStack.has(w)) {
                    low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!));
                }
                continue;
            }
            work.pop();
            if (work.length > 0) {
                const parent = work[work.length - 1].id;
                low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
            }
            if (low.get(frame.id) === index.get(frame.id)) {
                const part: number[] = [];
                let w: number;
                do { w = stack.pop()!; onStack.delete(w); part.push(w); } while (w !== frame.id);
                if (part.length > 1) {
                    const inPart = new Set(part);
                    found.push({
                        ids: part.sort((a, b) => a - b),
                        edges: part.flatMap((id) => out(id).filter((e) => inPart.has(e.on))),
                    });
                }
            }
        }
    }
    return found;
}

/**
 * Steps that can never wake on their ticket: their `resume_on` names a ticket
 * that is closed and has not moved since (it was closed before the step).
 */
export function deadResumes(ids: readonly number[]): Array<{ waiter: number; on: number }> {
    const live = ids.map((id) => ({ waiter: id, r: liveResumeOn(id) })).filter((x) => x.r !== null);
    const closed = closedTicketIds(live.map((x) => x.r!.on));
    return live.filter((x) => closed.has(x.r!.on)).map((x) => ({ waiter: x.waiter, on: x.r!.on }));
}
