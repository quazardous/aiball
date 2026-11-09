/**
 * #4866 — what a replica pulls from its master: the documents (tickets,
 * consumers) revised after its cursor, each one whole (`src/db/documents.ts`),
 * oldest revision first, and the master's last revision. Answered to a proxy node, and to a human on this
 * machine's socket (to look).
 */
import { hostname } from "node:os";
import { z } from "zod";
import { defineMethod, Refusal, type Caller } from "../methods.js";
import { ERROR_CODES } from "../../domain.js";
import { changesAfter, lastRev, revisedAfter, revOf, type DocKind } from "../../db/doc-revs.js";
import { documentOf } from "../../db/documents.js";
import { BOARD_TABLES, boardRows, boardSignatures } from "../../db/board-tables.js";
import { getRawSqlite } from "../../db/connection.js";
import { beginSwitching, endSwitching, switching } from "../../switch-state.js";
import { listConnectedNodeIds } from "../../proxy-ws.js";
import { boardCounts, SwitchNotReady, takeOver } from "../../master-switch.js";
import { markReplicaComplete } from "../../replica-node.js";
import { writeProxyConfig } from "../../proxy-config-write.js";
import { restartViaSupervisor } from "../../supervisor-restart.js";
import { isMachineLocal } from "../../machine-secret.js";

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

/** #4868 — a node may ask the master to hand the board over; only through its node token. */
function nodeOnly(caller: Caller): void {
    if (caller.token_kind !== "node") throw new Refusal(403, "only a node takes the board over, through its node token", ERROR_CODES.FORBIDDEN);
}

/**
 * #4868 — the master stops taking writes (they wait, their clients queue them)
 * and says its last revision, its counts and its board's signatures, for the
 * node taking over to check. Refused while another node is connected: it would
 * have to go through the new master's node (a cascade, not built).
 */
defineMethod({
    name: "replica.handover_begin",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => {
        nodeOnly(caller);
        const others = listConnectedNodeIds().length - 1;
        if (others > 0) {
            throw new Refusal(409, `${others} other node(s) connected to this master: they would lose it`, ERROR_CODES.SWITCH_NOT_READY, { reasons: ["other nodes connected"] });
        }
        const last = lastRev();
        beginSwitching({ to: caller.machine ?? "a node", since: new Date().toISOString(), last });
        return { last, machine: hostname(), counts: boardCounts(), board: boardSignatures() };
    },
});

/** #4868 — the switch did not happen: the master takes writes again. */
defineMethod({
    name: "replica.handover_abort",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => {
        nodeOnly(caller);
        endSwitching();
        return { switching: false };
    },
});

/** #4868 — at a switch only: the master's revisions, whole. */
defineMethod({
    name: "replica.doc_revs",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => {
        nodeOnly(caller);
        if (!switching()) throw new Refusal(409, "only while the board is handed over", ERROR_CODES.CONFLICT);
        return { rows: getRawSqlite().prepare(`SELECT * FROM doc_revs ORDER BY rowid`).all() };
    },
});

/**
 * #4868 — at a switch only: the master's tokens, whole, for the node taking
 * over to recognise its clients. The node asks only over https, a tailnet or
 * this machine (`secureLink`).
 */
defineMethod({
    name: "replica.tokens",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => {
        nodeOnly(caller);
        if (!switching()) throw new Refusal(409, "only while the board is handed over", ERROR_CODES.CONFLICT);
        return { rows: getRawSqlite().prepare(`SELECT * FROM tokens ORDER BY rowid`).all() };
    },
});

/**
 * #4868 — the point of no return: the master becomes the node's node. Its
 * `proxy:` block points at `url` with `token`, its database is a complete copy
 * level with its last revision; it restarts (unless `restart: false`).
 */
defineMethod({
    name: "replica.handover_commit",
    who: ["human", "agent"],
    params: z.object({ url: z.string().min(1), token: z.string().min(1), restart: z.boolean().optional(), by: z.string().nullable().optional() }),
    run: (caller, p) => {
        nodeOnly(caller);
        const s = switching();
        if (!s) throw new Refusal(409, "no switch begun", ERROR_CODES.CONFLICT);
        markReplicaComplete(s.last, boardSignatures());
        writeProxyConfig({ url: p.url, token: p.token });
        endSwitching();
        console.log(`[switch] this machine is now a node of ${p.url} (handed over at revision ${s.last}${p.by ? `, by ${p.by}` : ""})`);
        if (p.restart !== false) setTimeout(() => restartViaSupervisor({ selfIsDaemon: true }), 1_000).unref();
        return { ok: true, node_of: p.url, at: s.last };
    },
});

/**
 * #4868 — on a proxy node, take the board over from its master: the human's
 * gesture (`aiball master take`). `url` is where the master reaches this
 * machine. Refused with the reasons when a condition does not hold.
 */
defineMethod({
    name: "replica.take",
    // As `daemon.reload`: a gesture on the machine itself, over its local socket.
    who: ["human", "agent"],
    machine: true,
    params: z.object({ url: z.string().min(1), restart: z.boolean().optional() }),
    run: async (caller, p) => {
        if (!isMachineLocal(caller)) throw new Refusal(403, "a switch is made on the node itself", ERROR_CODES.FORBIDDEN);
        try {
            return await takeOver(p.url, { restart: p.restart, by: caller.consumer_id ?? undefined });
        } catch (e) {
            if (e instanceof SwitchNotReady) throw new Refusal(409, e.message, ERROR_CODES.SWITCH_NOT_READY, { reasons: e.reasons });
            throw e;
        }
    },
});
