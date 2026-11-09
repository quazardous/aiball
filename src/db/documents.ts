/**
 * #4866 — the board as a replica copies it: documents. A ticket's document is
 * its row and what hangs off it; a consumer's is its row and its own state
 * (pings, subscriptions, wakes, wait credit). Rows go as they are in the
 * database (column names, values), so the replica writes them back unchanged:
 * the same ids, dates and hashids.
 *
 * What each document holds is listed once, here. Left out: derived caches (the
 * compiled graph, which a replica builds itself) and a consumer's live
 * presence (its state, where its loop runs, when it was last seen, and the
 * `updated_at` its reports move), which each machine's loops report afresh.
 */
import { createHash } from "node:crypto";
import { getRawSqlite } from "./connection.js";
import type { DocKind } from "./doc-revs.js";

interface Part {
    table: string;
    /** The rows of this document: a WHERE clause naming the document's key `@key`. */
    where: string;
    /** Columns left out of the copy. */
    omit?: readonly string[];
}

/** A consumer's live presence: reported by each machine's loops, not copied. */
const PRESENCE = ["state", "state_since", "state_updated_at", "state_human", "state_human_word", "last_seen_at", "last_seen_via", "last_seen_ip", "cwd", "project", "updated_at"];

export const DOCUMENTS: Record<DocKind, readonly Part[]> = {
    ticket: [
        { table: "tickets", where: `"id" = @key` },
        { table: "_messages", where: `"ticket_id" = @key` },
        { table: "ticket_tags", where: `"ticket_id" = @key` },
        { table: "ticket_payloads", where: `"ticket_id" = @key` },
        { table: "ticket_token_usage", where: `"ticket_id" = @key` },
        // Every recipient's pings about it: the ticket's own, and its comments'.
        { table: "pings", where: `"ticket_id" = @key OR "comment_id" IN (SELECT "id" FROM "_messages" WHERE "ticket_id" = @key)` },
        // Every consumer's state about it: its subscription, its wakes, its credit moves.
        { table: "ticket_subscriptions", where: `"ticket_id" = @key` },
        { table: "backlog_wake_log", where: `"ticket_id" = @key` },
        { table: "wait_credit_moves", where: `"ticket_id" = @key` },
    ],
    consumer: [
        { table: "consumers", where: `"consumer_id" = @key`, omit: PRESENCE },
        { table: "subscriptions", where: `"consumer_id" = @key` },
        { table: "wait_credit_moves", where: `"consumer_id" = @key AND "ticket_id" IS NULL` },
    ],
};

export interface Document {
    kind: DocKind;
    key: string;
    rev: number;
    /** Its main row is gone: the replica removes the document. */
    deleted: boolean;
    /** Per table, its rows, in rowid order. */
    rows: Record<string, Array<Record<string, unknown>>>;
    /** A hash of `rows`, for the replica's per-document check. */
    hash: string;
}

export function documentOf(kind: DocKind, key: string, rev: number): Document {
    const db = getRawSqlite();
    const rows: Document["rows"] = {};
    const parts = DOCUMENTS[kind];
    for (const p of parts) {
        const all = db.prepare(`SELECT * FROM "${p.table}" WHERE ${p.where} ORDER BY rowid`).all({ key: kind === "ticket" ? Number(key) : key }) as Array<Record<string, unknown>>;
        rows[p.table] = p.omit ? all.map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => !p.omit!.includes(c)))) : all;
    }
    return { kind, key, rev, deleted: rows[parts[0].table].length === 0, rows, hash: rowsHash(kind, rows) };
}

/** The same rows give the same hash, on the master and on a replica. */
export function rowsHash(kind: DocKind, rows: Document["rows"]): string {
    const h = createHash("sha1");
    for (const { table } of DOCUMENTS[kind]) {
        h.update(table).update("\0");
        for (const r of rows[table] ?? []) {
            h.update(JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).update("\n");
        }
    }
    return h.digest("hex");
}
