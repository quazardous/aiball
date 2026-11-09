/**
 * #4866 — the board's numbers, from one object per sequence.
 *
 * A ticket's id and a message's id each come from a sequence (`ticket`,
 * `message`): a row holding its next number. A replica will insert tickets
 * and messages under the numbers they have on the master, and a node cut from
 * its master will number its own in a range reserved to it: so a sequence's
 * next number is checked before it is handed out. It must lie in no range
 * reserved to a node and belong to no row already there. If it does, `next`
 * refuses, naming the conflict, and the counter does not move: a number is
 * never skipped over silently, nor written over.
 *
 * Only this module reads or moves the sequences. Call `next` inside the
 * transaction that inserts the row, so the number and the row land together.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** The sequences, and the table each numbers. */
export const SEQUENCES = {
    ticket: { table: schema.tickets, id: schema.tickets.id, first: 1 },
    message: { table: schema.messages, id: schema.messages.id, first: 1_000_000 },
} as const;

export type SequenceName = keyof typeof SEQUENCES;

export class SequenceConflict extends Error {
    constructor(readonly sequence: SequenceName, readonly id: number, readonly reason: string) {
        super(`sequence ${sequence}: ${id} cannot be handed out: ${reason}`);
    }
}

/** The number `next` would hand out, without moving the counter. */
export function peek(db: Db, name: SequenceName): number {
    const row = db.select({ next: schema.sequences.next }).from(schema.sequences).where(eq(schema.sequences.name, name)).get();
    return row?.next ?? SEQUENCES[name].first;
}

/** Why `id` may not be handed out by `name`, or null when it is free. */
export function conflictOf(db: Db, name: SequenceName, id: number): string | null {
    const range = db.select().from(schema.sequenceRanges)
        .where(and(eq(schema.sequenceRanges.sequence, name), lte(schema.sequenceRanges.start, id), gte(schema.sequenceRanges.end, id)))
        .get();
    if (range) return `it lies in the range ${range.start}–${range.end} reserved to ${range.owner}`;
    if (taken(db, name, id)) return `a row already has it`;
    return null;
}

/** Whether a row numbered `id` by `name` already exists (a sync may have brought it). */
export function taken(db: Db, name: SequenceName, id: number): boolean {
    const s = SEQUENCES[name];
    return db.select({ id: s.id }).from(s.table).where(eq(s.id, id)).get() !== undefined;
}

/**
 * The next number of `name`, checked: free, it is handed out and the counter
 * moves on; otherwise `SequenceConflict`, and the counter stays.
 */
export function next(db: Db, name: SequenceName): number {
    const id = peek(db, name);
    const conflict = conflictOf(db, name, id);
    if (conflict) throw new SequenceConflict(name, id, conflict);
    db.insert(schema.sequences).values({ name, next: id + 1 })
        .onConflictDoUpdate({ target: schema.sequences.name, set: { next: id + 1 } })
        .run();
    return id;
}

/**
 * Reserve `size` numbers of `name` to `owner`, starting at `start`. Refused
 * when the range overlaps another one, or holds numbers already handed out.
 */
export function reserve(db: Db, name: SequenceName, owner: string, start: number, size: number, nowIso = new Date().toISOString()): { start: number; end: number } {
    if (!Number.isInteger(start) || !Number.isInteger(size) || size <= 0) throw new Error(`sequence ${name}: a range is a positive whole size from a whole start`);
    const end = start + size - 1;
    const overlap = db.select().from(schema.sequenceRanges)
        .where(and(eq(schema.sequenceRanges.sequence, name), lte(schema.sequenceRanges.start, end), gte(schema.sequenceRanges.end, start)))
        .get();
    if (overlap) throw new SequenceConflict(name, start, `the range ${start}–${end} overlaps ${overlap.start}–${overlap.end} reserved to ${overlap.owner}`);
    if (start < peek(db, name)) throw new SequenceConflict(name, start, `the range ${start}–${end} starts below the sequence's next number, ${peek(db, name)}`);
    db.insert(schema.sequenceRanges).values({ sequence: name, start, end, owner, createdAt: nowIso }).run();
    return { start, end };
}
