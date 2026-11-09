/**
 * #4866 — what a replica pulls from its master: the documents (tickets,
 * consumers) revised after its cursor, each one whole (`src/db/documents.ts`),
 * oldest revision first, and the master's last revision. Answered to a proxy node, and to a human on this
 * machine's socket (to look).
 */
import { z } from "zod";
import { defineMethod, Refusal, type Caller } from "../methods.js";
import { ERROR_CODES } from "../../domain.js";
import { changesAfter, lastRev, revisedAfter, revOf, type DocKind } from "../../db/doc-revs.js";
import { documentOf } from "../../db/documents.js";
import { BOARD_TABLES, boardRows, boardSignatures } from "../../db/board-tables.js";

/** A node (through its token), or a human on this machine's socket (to look). */
function replicaOnly(caller: Caller): void {
    const local = caller.transport === "uds" && caller.kind === "human" && !caller.relayed;
    if (caller.token_kind !== "node" && !local) {
        throw new Refusal(403, "a replica pulls through its node token", ERROR_CODES.FORBIDDEN);
    }
}

/** At most this many documents per pull: a replica catching up pulls again. */
export const PULL_MAX = 500;

/**
 * #4866 — the documents (tickets, consumers) revised after `after`, oldest
 * revision first, each whole; the master's last revision, and a signature per
 * board table.
 */
defineMethod({
    name: "replica.pull",
    who: ["human", "agent"],
    params: z.object({
        after: z.number().int().min(0),
        limit: z.number().int().min(1).max(PULL_MAX).optional(),
    }),
    run: (caller, p) => {
        replicaOnly(caller);
        const revs = revisedAfter(p.after, p.limit ?? PULL_MAX);
        return {
            last: lastRev(),
            documents: revs.map((r) => documentOf(r.kind, r.key, r.rev)),
            // The board's other tables: a replica asks again for those whose signature moved.
            board: boardSignatures(),
        };
    },
});

/** #4866 — the rows of the board's tables that belong to no document (`src/db/board-tables.ts`). */
defineMethod({
    name: "replica.board",
    who: ["human", "agent"],
    params: z.object({ tables: z.array(z.string()).optional() }),
    run: (caller, p) => {
        replicaOnly(caller);
        return { signatures: boardSignatures(), rows: boardRows(p.tables ?? BOARD_TABLES.map((t) => t.table)) };
    },
});

/** #4867 — at most this many headers per call: a node catching up asks again. */
export const CHANGES_MAX = 5000;
/** #4867 — at most this many documents per call. */
export const DOCS_MAX = 100;

/**
 * #4867 — what changed after `after`, as headers: `{ kind, key, rev, project }`,
 * oldest revision first, and a signature per board table. A node takes from
 * them the documents it keeps.
 */
defineMethod({
    name: "replica.changes",
    who: ["human", "agent"],
    params: z.object({
        after: z.number().int().min(0),
        limit: z.number().int().min(1).max(CHANGES_MAX).optional(),
    }),
    run: (caller, p) => {
        replicaOnly(caller);
        return { last: lastRev(), changes: changesAfter(p.after, p.limit ?? CHANGES_MAX), board: boardSignatures() };
    },
});

/** #4867 — these documents, whole, at their current revision. */
defineMethod({
    name: "replica.docs",
    who: ["human", "agent"],
    params: z.object({
        keys: z.array(z.object({ kind: z.enum(["ticket", "consumer"]), key: z.string() })).max(DOCS_MAX),
    }),
    run: (caller, p) => {
        replicaOnly(caller);
        return {
            last: lastRev(),
            documents: p.keys.map((k) => documentOf(k.kind as DocKind, k.key, revOf(k.kind as DocKind, k.key) ?? 0)),
        };
    },
});
