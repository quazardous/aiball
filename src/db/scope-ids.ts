/**
 * #2102 — the incremental bucket, defined once.
 *
 * Several derived-state builders were written as "read the board, fold it,
 * hand back a map" — and every caller then probes that map for the handful of
 * ids it already had. Answering about one ticket cost a full scan, and a
 * mutation pays it on every click: measured at 2.7-5.2 s per accept/close on a
 * thousand-ticket project.
 *
 * The fix is to read the ids you were asked about. The threshold is the part
 * worth stating: SQLite binds each id as a parameter, so past a certain count
 * the scan stops being the wasteful option and becomes the cheap one. Below it
 * we bind; above it — a full inbox load, a wake sweep — we scan, exactly as
 * before. That boundary IS the bucket size david asked the system to know.
 *
 * It sits well under SQLite's default parameter ceiling and far above the
 * handful any mutation or single-row refresh ever asks for, so neither end is
 * near it in practice.
 */
import { inArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export const SCOPED_READ_MAX_IDS = 200;

/** Whether a read should be bound to `ids` rather than scanning. */
export function shouldScope(ids: readonly number[] | undefined): ids is readonly number[] {
    return !!ids && ids.length > 0 && ids.length <= SCOPED_READ_MAX_IDS;
}

/**
 * The `inArray` condition for `ids`, or undefined when the read should scan.
 *
 * Returns a CONDITION rather than applying it, deliberately: drizzle's
 * `.where()` REPLACES any previous one instead of anding it, so a helper that
 * called `.where()` on a query that already had a filter would silently drop
 * that filter. Handing back a condition forces the caller to compose it with
 * `and(…)`, which cannot lose anything.
 */
export function idScope(col: SQLiteColumn, ids: readonly number[] | undefined): SQL | undefined {
    return shouldScope(ids) ? inArray(col, [...ids]) : undefined;
}
