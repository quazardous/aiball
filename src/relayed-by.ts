/**
 * #3349 — which proxy node an agent comes through, from the calls it makes:
 * a relayed call is authenticated by the node's own token, so the node is
 * known exactly. Its address was not: behind tailscale serve every node
 * arrives from the loopback, and a relayed call records no address at all
 * (a node never seen matched an agent never seen, null === null).
 *
 * Kept in memory: it only matters while the node is connected, and a relayed
 * agent calls within a minute of a daemon restart.
 */
const via = new Map<string, string>();

/** A call of `consumer` came through the node `nodeId`. */
export function noteRelayed(consumer: string, nodeId: string): void {
    via.set(consumer, nodeId);
}

/** The node `consumer` last came through since this daemon started, or null. */
export function nodeOfConsumer(consumer: string): string | null {
    return via.get(consumer) ?? null;
}

/** The consumers whose last relayed call came through `nodeId`. */
export function consumersRelayedBy(nodeId: string): string[] {
    return [...via].filter(([, n]) => n === nodeId).map(([c]) => c);
}

/** Tests only. */
export function resetRelayedForTests(): void {
    via.clear();
}
