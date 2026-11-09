/**
 * #4866 — each document's revision, for the replicas.
 *
 * A replica copies the board as documents: a ticket (its thread, tags,
 * payload, tokens, and every consumer's state about it: pings, subscriptions,
 * wakes, credit moves) and a consumer (its row, project subscriptions, credit
 * moves tied to no ticket). When
 * something about a document changes, it takes the next number of the `rev`
 * sequence: its revision. A replica asks for the documents revised after its
 * cursor and gets each one whole (`src/db/documents.ts`).
 *
 * A ticket is revised on `ticketChanged`, which every write of a ticket's state
 * already announces, and by the writers of what else its document holds
 * (tags, payload, tokens, pings, subscriptions, wakes, credit moves). A
 * consumer is revised by the writers of its row, its project subscriptions
 * and its credit moves tied to no ticket. A change that names
 * no one revises every document of its kind.
 *
 * A revision is taken right after the write: a process that dies in between
 * loses one, and the replica's periodic per-document check is what catches it.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";
import { next } from "./sequences.js";
import { onTicketChanged } from "./ticket-change.js";

export type DocKind = "ticket" | "consumer";

type RevisedListener = (last: number) => void;
const revisedListeners = new Set<RevisedListener>();

/** Hear each revision handed out, with the last one; returns the way to stop. */
export function onRevised(fn: RevisedListener): () => void {
    revisedListeners.add(fn);
    return () => { revisedListeners.delete(fn); };
}

/** Give each of these documents (every one of the kind with `"all"`) its next revision. */
export function revise(kind: DocKind, keys: ReadonlyArray<string | number> | "all"): void {
    const db = getDb();
    db.transaction((tx) => {
        // "all": every document of the kind there is, and every one there was
        // (a document deleted since its last revision must say it is gone).
        const targets = keys === "all"
            ? [...new Set([
                ...(kind === "ticket"
                    ? tx.select({ k: schema.tickets.id }).from(schema.tickets).orderBy(asc(schema.tickets.id)).all().map((r) => String(r.k))
                    : tx.select({ k: schema.consumers.consumerId }).from(schema.consumers).orderBy(asc(schema.consumers.consumerId)).all().map((r) => r.k)),
                ...tx.select({ k: schema.docRevs.key }).from(schema.docRevs).where(eq(schema.docRevs.kind, kind)).all().map((r) => r.k),
            ])]
            : [...new Set(keys.map(String))];
        for (const key of targets) {
            const rev = next(tx as never, "rev");
            tx.insert(schema.docRevs).values({ kind, key, rev })
                .onConflictDoUpdate({ target: [schema.docRevs.kind, schema.docRevs.key], set: { rev } })
                .run();
        }
    });
    if (revisedListeners.size > 0) {
        const last = lastRev();
        for (const fn of revisedListeners) {
            try { fn(last); } catch { /* a listener never breaks a write */ }
        }
    }
}

export const reviseTickets = (ids: ReadonlyArray<number> | "all") => revise("ticket", ids);
export const reviseConsumers = (ids: ReadonlyArray<string> | "all") => revise("consumer", ids);

/** The last revision handed out (0 before any). */
export function lastRev(): number {
    return getDb().select({ m: sql<number | null>`max(${schema.docRevs.rev})` }).from(schema.docRevs).get()?.m ?? 0;
}

/** The documents revised after `after`, oldest revision first, at most `limit`. */
export function revisedAfter(after: number, limit: number): Array<{ kind: DocKind; key: string; rev: number }> {
    return getDb().select({ kind: schema.docRevs.kind, key: schema.docRevs.key, rev: schema.docRevs.rev })
        .from(schema.docRevs)
        .where(gt(schema.docRevs.rev, after))
        .orderBy(asc(schema.docRevs.rev))
        .limit(limit)
        .all() as Array<{ kind: DocKind; key: string; rev: number }>;
}

/** A document's revision, or null when it never had one. */
export function revOf(kind: DocKind, key: string | number): number | null {
    return getDb().select({ rev: schema.docRevs.rev }).from(schema.docRevs)
        .where(and(eq(schema.docRevs.kind, kind), eq(schema.docRevs.key, String(key)))).get()?.rev ?? null;
}

onTicketChanged((change) => {
    if (change.everything) reviseTickets("all");
    else if (change.ticket_ids.length > 0) reviseTickets(change.ticket_ids);
});
