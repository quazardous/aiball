/**
 * #3245 — a write's idempotency key: the message it made, kept a week, so a
 * client that sends the same write again (its first call timed out, its spool
 * replays it) is answered with that message instead of getting a second one.
 * A key belongs to its author: someone else's key answers nothing.
 */
import { and, eq, lt } from "drizzle-orm";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

/** How long a key is remembered: longer than any spool waits for its daemon. */
const KEEP_MS = 7 * 24 * 3_600_000;

/** A key the client may send: long enough not to collide, short enough to index. */
export function isIdempotencyKey(v: unknown): v is string {
    return typeof v === "string" && v.length >= 8 && v.length <= 128;
}

/** The message `author`'s write with this key made, or null. */
export function keyedMessage(key: string, author: string): number | null {
    const row = getDb().select({ id: schema.idempotencyKeys.messageId }).from(schema.idempotencyKeys)
        .where(and(eq(schema.idempotencyKeys.key, key), eq(schema.idempotencyKeys.author, author))).get();
    return row?.id ?? null;
}

/** Remember that `author`'s write with this key made `messageId`; forget the keys past their week. */
export function rememberKey(key: string, author: string, messageId: number, nowMs = Date.now()): void {
    const db = getDb();
    db.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, new Date(nowMs - KEEP_MS).toISOString())).run();
    db.insert(schema.idempotencyKeys).values({ key, author, messageId, createdAt: new Date(nowMs).toISOString() })
        .onConflictDoNothing().run();
}
