/**
 * Upstream coupling phase 2 — MCP tool-surfacing gate (#1542).
 *
 * The `ticket_import` / `ticket_export` tools surface for an agent ONLY when
 * BOTH hold:
 *   1. the agent's project has an upstream binding configured (there's a repo
 *      to couple to), AND
 *   2. the agent is a project OWNER — the "lead". Owner/follower is the only
 *      role model today, so owner == lead; this stays correct once an explicit
 *      lead/crew split lands, since crew won't hold the owner role.
 *
 * Pure function so it's unit-testable without a live MCP / daemon.
 */
export interface UpstreamVisibilityInput {
    /** The agent's resolved project (client.defaultProject). */
    project: string | null | undefined;
    /** The daemon's resolved `upstream` map (from GET /api/config). */
    upstream: Record<string, unknown[]> | undefined;
    /** The agent's subscriptions (from client.mySubs()). */
    subs: Array<{ project: string; role: string }>;
}

export function shouldSurfaceUpstreamTools(input: UpstreamVisibilityInput): boolean {
    const { project, upstream, subs } = input;
    if (!project) return false;
    const bindings = upstream?.[project];
    const hasBinding = Array.isArray(bindings) && bindings.length > 0;
    if (!hasBinding) return false;
    return subs.some((s) => s.project === project && s.role === "owner");
}
