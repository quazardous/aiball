/**
 * #4866 — the board's tables that are no ticket's and no consumer's: small, or
 * only ever appended to, copied to a replica table by table. Each has a
 * signature; a replica asks again for the tables whose signature moved.
 *
 * Every table of the schema is placed once: in a document (`documents.ts`),
 * here, or left out with its reason. A test fails on a table placed nowhere.
 */
import { createHash } from "node:crypto";
import { getRawSqlite } from "./connection.js";

/** `full`: hashed whole (small, and changed in place). `append`: only added to, or pruned: its count and last rowid say it. */
export const BOARD_TABLES: ReadonlyArray<{ table: string; mode: "full" | "append" }> = [
    { table: "projects", mode: "full" },
    { table: "tags", mode: "full" },
    { table: "automation_rules", mode: "full" },
    { table: "config_overrides", mode: "full" },
    { table: "settings", mode: "full" },
    { table: "sequences", mode: "full" },
    { table: "sequence_ranges", mode: "full" },
    { table: "signals", mode: "full" },
    { table: "uploads", mode: "append" },
    { table: "project_token_usage", mode: "full" },
    { table: "token_usage_snapshot", mode: "append" },
    { table: "signal_deliveries", mode: "append" },
    { table: "idempotency_keys", mode: "append" },
    { table: "master_switches", mode: "append" },
];

/** Left out of the copy, each with why. */
export const NOT_COPIED: Readonly<Record<string, string>> = {
    tokens: "credentials: each machine mints and keeps its own",
    node_project_config: "a node's own config, pushed by that node",
    node_enrollments: "pairing requests, answered on the machine they reach",
    node_revocations: "revoked node tokens, kept where the tokens are",
    graph_edges: "derived: compiled from the messages",
    graph_meta: "derived: the compiler's own state",
    doc_revs: "the master's revisions: a replica keeps its own cursor",
    __drizzle_migrations: "each database's own migration record",
};

/** Derived search indexes (FTS5 and their shadow tables): rebuilt from the rows. */
export const isDerivedIndex = (table: string): boolean => /^(messages|tickets)_fts(_|$)/.test(table);

/** Each board table's signature: what moved since the replica's copy. */
export function boardSignatures(): Record<string, string> {
    const db = getRawSqlite();
    const out: Record<string, string> = {};
    for (const { table, mode } of BOARD_TABLES) {
        if (mode === "append") {
            const r = db.prepare(`SELECT count(*) AS n, max(rowid) AS m FROM "${table}"`).get() as { n: number; m: number | null };
            out[table] = `${r.n}:${r.m ?? 0}`;
        } else {
            const h = createHash("sha1");
            for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>) {
                h.update(JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]))).update("\n");
            }
            out[table] = h.digest("hex");
        }
    }
    return out;
}

/** The rows of these board tables, as they are in the database. */
export function boardRows(tables: readonly string[]): Record<string, Array<Record<string, unknown>>> {
    const db = getRawSqlite();
    const known = new Set(BOARD_TABLES.map((t) => t.table));
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const t of tables) {
        if (!known.has(t)) throw new Error(`not a board table: ${t}`);
        out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    }
    return out;
}
