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
    /** #524: provider-resolved hostname shipped in the WS `hello` frame
     *  (tailscale → hostname → …). NULL if the node never advertised it
     *  (legacy pre-#524 or non-WS node). */
    display_host: string | null;
    /** #524: id of the provider that resolved `display_host` (`"tailscale"`,
     *  `"hostname"`, …). NULL when display_host is NULL. Used by the UI for a
     *  chip beside the host. */
    display_host_provider: string | null;
    /** Consumers this node relays (matched by last_seen_ip). */
    relayed: RelayedConsumer[];
    relayed_count: number;
    /** #2085 — set on a node that no longer exists: its credential is gone, and
     *  this row is the receipt for the click that destroyed it. Shown greyed
     *  for a while, then forgotten. NULL on a live node. */
    revoked_at?: string | null;
    revoked_by?: string | null;
}

/**
 * #2085 — how long a revoked node stays on the list. Short, for the same reason
 * a refused pairing request is: someone was there and pressed the button, so
 * what is owed is an acknowledgement, not a record outliving their afternoon.
 * The permanent audit of a credential's life is not this panel's job.
 */
export const REVOKED_RETENTION_MS = 60 * 60 * 1000;

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
            display_host: n.displayHost ?? null,
            display_host_provider: n.displayHostProvider ?? null,
            relayed: rel,
            relayed_count: rel.length,
        };
    });
}

/**
 * #2085 — live nodes plus the ones revoked recently enough to still be news.
 * A tombstone can never relay anything, so it carries no consumers; everything
 * else is what the panel last showed, copied at revocation so the row still
 * reads like the node it replaces.
 */
export function listNodesWithRevoked(nowMs: number = Date.now()): NodeView[] {
    const cutoff = new Date(nowMs - REVOKED_RETENTION_MS).toISOString();
    const tombs = getDb().select().from(schema.nodeRevocations).all()
        .filter((r) => r.revokedAt > cutoff)
        .map((r): NodeView => ({
            node_id: r.nodeId,
            label: r.label,
            created_at: r.createdAt ?? r.revokedAt,
            last_used_at: r.lastUsedAt,
            last_seen_ip: r.lastSeenIp,
            display_host: r.displayHost,
            display_host_provider: r.displayHostProvider,
            relayed: [],
            relayed_count: 0,
            revoked_at: r.revokedAt,
            revoked_by: r.revokedBy,
        }));
    return [...listNodes(), ...tombs];
}

/**
 * Revoke a node by its non-secret handle. The token row is DELETED, exactly as
 * before — the credential ceases to exist and no lookup has to learn a new rule
 * to keep refusing it. #2085 only adds a tombstone first, so the panel can show
 * for an hour that this is what happened, instead of a row silently vanishing.
 */
export function revokeNode(node_id: string, by?: string | null): boolean {
    const db = getDb();
    const nodes = db.select()
        .from(schema.tokens)
        .where(eq(schema.tokens.kind, "node"))
        .all();
    const match = nodes.find((n) => nodeId(n.token) === node_id);
    if (!match) return false;
    const r = db.delete(schema.tokens).where(eq(schema.tokens.token, match.token)).run();
    if (r.changes === 0) return false;
    // After the delete, and best-effort: a tombstone that fails to be written
    // must never leave a credential alive. `onConflictDoUpdate` so re-minting
    // and revoking the same node twice overwrites rather than throws.
    try {
        const row = {
            nodeId: node_id,
            label: match.label ?? null,
            displayHost: match.displayHost ?? null,
            displayHostProvider: match.displayHostProvider ?? null,
            lastSeenIp: match.lastSeenIp ?? null,
            createdAt: match.createdAt ?? null,
            lastUsedAt: match.lastUsedAt ?? null,
            revokedAt: new Date().toISOString(),
            revokedBy: by ?? null,
        };
        db.insert(schema.nodeRevocations).values(row)
            .onConflictDoUpdate({ target: schema.nodeRevocations.nodeId, set: row })
            .run();
    } catch (e) {
        console.error("node revocation tombstone failed (the token IS revoked):", e);
    }
    return true;
}
