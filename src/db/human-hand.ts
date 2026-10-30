/**
 * #4452 — the tickets a human keeps the hand on: their last action is a human's
 * plain comment with `handback: false`. Said something, not done, nobody acts
 * on it yet: out of every agent's actionable pool and backlog, and the comment
 * pings no one (`fanOutPings`). It ends with the next action on the ticket,
 * which moves `last_actor` / `last_actor_at` off that comment.
 *
 * The comment is the one that set `last_actor`: same author, and `created_at`
 * equal to `last_actor_at`, as in `ticketsWhereLastActionKeepsAuthor`.
 */
import { and, eq, like, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { isHuman } from "./consumers.js";
import { onTicketChanged } from "./ticket-change.js";
import { isStepMeta, readHandback } from "../ticket-transitions.js";

/**
 * Kept until a ticket changes, as `allClosedTicketIds`: the read costs about
 * 70 ms on a real board, and every pool and wake rule asks. This listener runs
 * before the ones repairing the actionable sets, because their module imports
 * this one, so a repair reads the fresh set.
 */
const CEILING_MS = 60_000;
let held: { ids: ReadonlySet<number>; until: number } | null = null;
onTicketChanged(() => { held = null; });

export function ticketsHeldByHuman(nowMs: number = Date.now()): ReadonlySet<number> {
    if (!held || nowMs >= held.until) held = { ids: readHeldByHuman(), until: nowMs + CEILING_MS };
    return held.ids;
}

function readHeldByHuman(): Set<number> {
    const out = new Set<number>();
    const humans = new Map<string, boolean>();
    for (const r of getDb().select({
        id: schema.tickets.id,
        lastActor: schema.tickets.lastActor,
        meta: schema.messages.meta,
    }).from(schema.messages)
        .innerJoin(schema.tickets, eq(schema.messages.ticketId, schema.tickets.id))
        .where(and(
            eq(schema.messages.kind, "comment_added"),
            like(schema.messages.meta, '%"handback":false%'),
            sql`${schema.messages.byAgent} = ${schema.tickets.lastActor}`,
            sql`${schema.messages.createdAt} = ${schema.tickets.lastActorAt}`,
        )).all()) {
        if (!r.lastActor || isStepMeta(r.meta) || readHandback(r.meta) !== false) continue;
        let human = humans.get(r.lastActor);
        if (human === undefined) humans.set(r.lastActor, human = isHuman(r.lastActor));
        if (human) out.add(r.id);
    }
    return out;
}
