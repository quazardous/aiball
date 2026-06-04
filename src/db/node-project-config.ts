/**
 * #775 — store + readers for the per-(node, project) config the proxy
 * node pushes via the WS reverse channel. Schema lives in `schema.ts`
 * (`nodeProjectConfig`). Reads are by `node_token` or by `consumer_id`
 * (the latter scans configs to find which one declares the agent —
 * the daemon side derives `consumers.can_claim` from `no_claim`).
 */
import { and, eq } from "drizzle-orm";
import { getDb, nowIso } from "./connection.js";
import * as schema from "../schema.js";

export interface NodeProjectConfigConsumer {
    /** consumer_id the proxy node relays. */
    agent: string;
    /** Mirror of `.aiball.yaml consumer.no_claim`. */
    no_claim?: boolean;
}

export interface NodeProjectConfigPayload {
    consumers: NodeProjectConfigConsumer[];
}

export interface NodeProjectConfigRow {
    node_token: string;
    project: string;
    config: NodeProjectConfigPayload;
    updated_at: string;
}

function parseConfig(json: string): NodeProjectConfigPayload {
    try {
        const v = JSON.parse(json) as unknown;
        if (v && typeof v === "object" && Array.isArray((v as { consumers?: unknown }).consumers)) {
            return v as NodeProjectConfigPayload;
        }
    } catch { /* fall through */ }
    return { consumers: [] };
}

/**
 * Upsert the (node, project) row with the latest pushed config payload.
 * Idempotent — repeated pushes refresh `updated_at`.
 */
export function upsertNodeProjectConfig(
    node_token: string,
    project: string,
    config: NodeProjectConfigPayload,
): NodeProjectConfigRow {
    const db = getDb();
    const json = JSON.stringify(config);
    const now = nowIso();
    db.insert(schema.nodeProjectConfig)
        .values({
            nodeToken: node_token,
            project,
            configJson: json,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [schema.nodeProjectConfig.nodeToken, schema.nodeProjectConfig.project],
            set: { configJson: json, updatedAt: now },
        })
        .run();
    return { node_token, project, config, updated_at: now };
}

/** List every config row pushed by a given node — useful for the Nodes
 *  panel + debug. */
export function listConfigsForNode(node_token: string): NodeProjectConfigRow[] {
    const db = getDb();
    return db.select()
        .from(schema.nodeProjectConfig)
        .where(eq(schema.nodeProjectConfig.nodeToken, node_token))
        .all()
        .map((r) => ({
            node_token: r.nodeToken,
            project: r.project,
            config: parseConfig(r.configJson),
            updated_at: r.updatedAt,
        }));
}

/** Find the config that declares `agent` for `project`. Returns the
 *  matching consumer entry + its row metadata, or null when no node has
 *  pushed a config for this (agent, project) pair. Used by the daemon to
 *  decide `consumers.can_claim` post-push (#775). */
export function findConsumerConfig(
    agent: string,
    project: string,
): { row: NodeProjectConfigRow; consumer: NodeProjectConfigConsumer } | null {
    const db = getDb();
    const rows = db.select()
        .from(schema.nodeProjectConfig)
        .where(eq(schema.nodeProjectConfig.project, project))
        .all();
    for (const r of rows) {
        const config = parseConfig(r.configJson);
        const c = config.consumers.find((c) => c.agent === agent);
        if (c) {
            return {
                row: { node_token: r.nodeToken, project: r.project, config, updated_at: r.updatedAt },
                consumer: c,
            };
        }
    }
    return null;
}

/** Remove all config rows owned by `node_token`. Called when a node's
 *  token is revoked — keeps the table from holding ghost configs. */
export function deleteConfigsForNode(node_token: string): void {
    const db = getDb();
    db.delete(schema.nodeProjectConfig)
        .where(eq(schema.nodeProjectConfig.nodeToken, node_token))
        .run();
}

/** Lookup a single (node, project) row directly. */
export function getNodeProjectConfig(
    node_token: string,
    project: string,
): NodeProjectConfigRow | null {
    const db = getDb();
    const r = db.select()
        .from(schema.nodeProjectConfig)
        .where(and(
            eq(schema.nodeProjectConfig.nodeToken, node_token),
            eq(schema.nodeProjectConfig.project, project),
        ))
        .get();
    if (!r) return null;
    return {
        node_token: r.nodeToken,
        project: r.project,
        config: parseConfig(r.configJson),
        updated_at: r.updatedAt,
    };
}
