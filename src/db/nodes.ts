// #424 — the Nodes view: each proxy node = a `tokens` row with kind='node'
// (minted by `aiball auth issue --node`). This assembles a panel-friendly view
// — label, created/last-used, the node's last peer IP — and groups the
// consumers it relays (consumers.last_seen_via='node' with a matching
// last_seen_ip). The token VALUE is never exposed: a node is addressed by a
// stable, non-secret `node_id` = sha256(token) prefix.
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../schema.js";
import { getDb } from "./connection.js";

export interface RelayedConsumer {
    consumer_id: string;
    last_seen_at: string | null;
}

export interface NodeView {
    /** Stable, non-secret handle (sha256(token) prefix) — use for revoke. */
    node_id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    /** The node's last peer IP (stamped on relay). NULL if never used since #424. */
    last_seen_ip: string | null;
    /** Consumers this node relays (matched by last_seen_ip). */
    relayed: RelayedConsumer[];
    relayed_count: number;
}

/** Non-secret handle for a node token (never expose the token value). */
export function nodeId(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Match the node-relayed consumers to a node by its peer IP. Pure (no DB) so it
 * unit-tests. A node with no recorded IP relays nobody we can attribute yet.
 */
export function relayedFor(
    nodeIp: string | null,
    relayed: { consumer_id: string; last_seen_ip: string | null; last_seen_at: string | null }[],
): RelayedConsumer[] {
    if (!nodeIp) return [];
    return relayed
        .filter((c) => c.last_seen_ip === nodeIp)
        .map((c) => ({ consumer_id: c.consumer_id, last_seen_at: c.last_seen_at }));
}

export function listNodes(): NodeView[] {
    const db = getDb();
    const nodes = db.select().from(schema.tokens).where(eq(schema.tokens.kind, "node")).all();
    const relayed = db.select({
        consumer_id: schema.consumers.consumerId,
        last_seen_ip: schema.consumers.lastSeenIp,
        last_seen_at: schema.consumers.lastSeenAt,
    })
        .from(schema.consumers)
        .where(eq(schema.consumers.lastSeenVia, "node"))
        .all();
    return nodes.map((n) => {
        const rel = relayedFor(n.lastSeenIp ?? null, relayed);
        return {
            node_id: nodeId(n.token),
            label: n.label,
            created_at: n.createdAt,
            last_used_at: n.lastUsedAt,
            last_seen_ip: n.lastSeenIp ?? null,
            relayed: rel,
            relayed_count: rel.length,
        };
    });
}

/** Revoke a node by its non-secret handle (deletes the underlying token). */
export function revokeNode(node_id: string): boolean {
    const db = getDb();
    const nodes = db.select({ token: schema.tokens.token })
        .from(schema.tokens)
        .where(eq(schema.tokens.kind, "node"))
        .all();
    const match = nodes.find((n) => nodeId(n.token) === node_id);
    if (!match) return false;
    const r = db.delete(schema.tokens).where(eq(schema.tokens.token, match.token)).run();
    return r.changes > 0;
}
