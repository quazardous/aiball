/**
 * #4867 — a node writes the documents and board tables it receives from its
 * master into its own database, as they are: the same rows, ids and dates.
 *
 * The node's copy is partial (it keeps the tickets that concern it): a ticket
 * kept may name one that is not (its parent, its milestone, a relation). So
 * the rows are written with the foreign keys unchecked; a read that follows a
 * reference to a ticket not kept finds nothing, as a read on the master would
 * not, and the node's background replication fills the rest in time.
 *
 * A document replaces the node's copy of it whole. A consumer's row keeps the
 * node's own presence columns (the document leaves them out): it is updated in
 * place, not replaced.
 */
import type Database from "better-sqlite3";
import { getRawSqlite } from "./connection.js";
import { DOCUMENTS, type Document } from "./documents.js";
import type { DocKind } from "./doc-revs.js";

/** Write `fn` with the foreign keys unchecked, in one transaction. */
function unchecked(db: Database.Database, fn: () => void): void {
    const fk = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
        db.transaction(fn)();
    } finally {
        db.pragma(`foreign_keys = ${fk ? "ON" : "OFF"}`);
    }
}

function insertRow(db: Database.Database, table: string, row: Record<string, unknown>, upsertOn?: string): void {
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const names = cols.map((c) => `"${c}"`).join(", ");
    const params = cols.map((c) => `@${c}`).join(", ");
    const tail = upsertOn
        ? ` ON CONFLICT("${upsertOn}") DO UPDATE SET ${cols.filter((c) => c !== upsertOn).map((c) => `"${c}" = excluded."${c}"`).join(", ") || `"${upsertOn}" = excluded."${upsertOn}"`}`
        : "";
    db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${params})${tail}`).run(row);
}

/** Replace the node's copy of these documents with them. A deleted one is removed. */
export function applyDocuments(docs: readonly Document[]): void {
    const db = getRawSqlite();
    unchecked(db, () => {
        for (const doc of docs) {
            const parts = DOCUMENTS[doc.kind];
            const key = { key: doc.kind === "ticket" ? Number(doc.key) : doc.key };
            // What hangs off the document goes first; the main row last, and a
            // consumer's main row is kept for its presence columns.
            for (const p of [...parts].reverse()) {
                if (p.omit && !doc.deleted) continue;
                db.prepare(`DELETE FROM "${p.table}" WHERE ${p.where}`).run(key);
            }
            if (doc.deleted) continue;
            for (const p of parts) {
                for (const row of doc.rows[p.table] ?? []) {
                    // A row whose columns the document leaves out (a consumer's presence)
                    // is new here only on insert: its `updated_at` starts at its creation.
                    const full = p.omit && !("updated_at" in row) && "created_at" in row ? { ...row, updated_at: row.created_at } : row;
                    insertRow(db, p.table, full, p.omit ? keyColumn(doc.kind) : undefined);
                }
            }
        }
    });
}

function keyColumn(kind: DocKind): string {
    return kind === "ticket" ? "id" : "consumer_id";
}

/** Replace these board tables whole with the master's rows. */
export function applyBoardTables(rows: Record<string, ReadonlyArray<Record<string, unknown>>>): void {
    const db = getRawSqlite();
    unchecked(db, () => {
        for (const [table, list] of Object.entries(rows)) {
            db.prepare(`DELETE FROM "${table}"`).run();
            for (const row of list) insertRow(db, table, row);
        }
    });
}

/** Whether the node keeps this document (has its main row). */
export function keeps(kind: DocKind, key: string): boolean {
    const p = DOCUMENTS[kind][0];
    return getRawSqlite().prepare(`SELECT 1 FROM "${p.table}" WHERE ${p.where}`).get({ key: kind === "ticket" ? Number(key) : key }) !== undefined;
}

/**
 * #4868 — at a master switch only: the master's revisions and its tokens,
 * taken whole, so the node that becomes master continues its numbering and
 * knows its clients. Neither is copied otherwise (`board-tables.ts`).
 */
export function applyTableWhole(table: "doc_revs" | "tokens", rows: ReadonlyArray<Record<string, unknown>>): void {
    applyBoardTables({ [table]: rows });
}
