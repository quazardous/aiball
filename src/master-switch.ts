/**
 * #4868 — handing the board over from its master (A) to one of its nodes (B):
 * a human's gesture, made on B (`aiball master take`). Nothing has to be merged:
 * only one side writes at a time.
 *
 *  1. B checks its conditions: its copy is complete, its link to A is https, a
 *     tailnet or this machine (A's tokens will cross it).
 *  2. A stops taking writes (`replica.handover_begin`): they wait, their clients
 *     queue them; A says its last revision and what its board holds.
 *  3. B catches up to that revision, takes A's revisions and tokens whole, and
 *     checks it holds what A holds. A mismatch aborts: A takes writes again.
 *  4. B mints a node token for A, and A becomes B's node (`replica.handover_commit`):
 *     its `proxy:` block points at B, its database is a complete copy.
 *  5. B drops its own `proxy:` block: it is the master. Both restart.
 *
 * Until step 4 nothing is changed but A's pause; an error aborts it.
 */
import { getRawSqlite } from "./db/connection.js";
import { boardSignatures } from "./db/board-tables.js";
import { applyTableWhole } from "./db/replica-apply.js";
import { issueToken } from "./db/tokens.js";
import { forgetReplicaState, readReplicaState, replicaNode, type ReplicaNode } from "./replica-node.js";
import { loadProxy } from "./proxy.js";
import { removeProxyConfig } from "./proxy-config-write.js";
import { restartViaSupervisor } from "./supervisor-restart.js";

export interface HandoverBegun {
    last: number;
    counts: Record<string, number>;
    board: Record<string, string>;
}

/** The counts a node checks against its master's, table by table. */
export const COUNTED = ["tickets", "_messages", "consumers", "pings", "ticket_subscriptions", "ticket_tags"] as const;

export function boardCounts(): Record<string, number> {
    const db = getRawSqlite();
    return Object.fromEntries(COUNTED.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]));
}

/** Whether `url` is a link A's tokens may cross: https, a tailnet address, or this machine. */
export function secureLink(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol === "https:") return true;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
    if (h.endsWith(".ts.net")) return true;
    const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
    return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export class SwitchNotReady extends Error {
    constructor(readonly reasons: string[]) {
        super(`the switch cannot start: ${reasons.join("; ")}`);
    }
}

export interface TakeResult {
    from: string;
    to: string;
    last: number;
    counts: Record<string, number>;
    restarting: boolean;
}

/**
 * B takes the board over from its master. `selfUrl` is where A reaches B (A's
 * `proxy.url` from then on). `restart: false` leaves the restarts to the caller
 * (a test, a bench).
 */
export async function takeOver(selfUrl: string, opts: { restart?: boolean; by?: string } = {}, node: ReplicaNode | null = replicaNode()): Promise<TakeResult> {
    const cfg = loadProxy();
    const reasons: string[] = [];
    if (!cfg || !node) reasons.push("this daemon is not a proxy node: it has no master to take over from");
    if (!secureLink(selfUrl)) reasons.push(`${selfUrl} is not https, a tailnet address or this machine: the master's tokens would cross it in clear`);
    if (cfg && !secureLink(cfg.url)) reasons.push(`the link to the master (${cfg.url}) is not https, a tailnet address or this machine`);
    if (node && !readReplicaState().complete) reasons.push("this node's copy is not complete yet (its background replication is still going)");
    if (reasons.length > 0 || !cfg || !node) throw new SwitchNotReady(reasons);

    const begun = await node.call<HandoverBegun>("replica.handover_begin", {});
    try {
        // Level with A's last revision: its writes are paused, so this ends.
        for (let i = 0; i < 20 && readReplicaState().cursor < begun.last; i++) await node.sync();
        if (readReplicaState().cursor < begun.last) throw new Error(`could not reach the master's revision ${begun.last} (at ${readReplicaState().cursor})`);
        applyTableWhole("doc_revs", (await node.call<{ rows: Array<Record<string, unknown>> }>("replica.doc_revs", {})).rows);
        applyTableWhole("tokens", (await node.call<{ rows: Array<Record<string, unknown>> }>("replica.tokens", {})).rows);
        // What this node holds must be what the master holds.
        const mine = boardCounts();
        const drift = Object.keys(begun.counts).filter((t) => mine[t] !== begun.counts[t]).map((t) => `${t}: master ${begun.counts[t]}, here ${mine[t] ?? "?"}`);
        const board = boardSignatures();
        for (const t of Object.keys(begun.board)) if (board[t] !== begun.board[t] && t !== "idempotency_keys") drift.push(`${t} differs`);
        if (drift.length > 0) throw new Error(`this copy is not the master's: ${drift.join(", ")}`);
    } catch (e) {
        await node.call("replica.handover_abort", {}).catch(() => { /* A's pause ends with its next restart at worst */ });
        throw e;
    }

    // The point of no return: A becomes this node's node.
    const forA = issueToken({ kind: "node", label: "former master" }).token;
    await node.call("replica.handover_commit", { url: selfUrl, token: forA, restart: opts.restart !== false, by: opts.by ?? null });
    removeProxyConfig();
    forgetReplicaState();
    console.log(`[switch] this machine is the master now (from ${cfg.url}, at revision ${begun.last})`);
    const restarting = opts.restart !== false;
    if (restarting) setTimeout(() => restartViaSupervisor({ selfIsDaemon: true }), 1_000).unref();
    return { from: cfg.url, to: selfUrl, last: begun.last, counts: begun.counts, restarting };
}
