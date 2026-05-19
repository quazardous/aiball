/**
 * Shared helpers for the aiball MCP server's tool clusters (carved
 * out of src/mcp.ts in #B.213 phase 4.A on 2026-05-19). Behavior-
 * preserving move.
 *
 * Holds:
 *   - the singleton `AiballClient` used by every tool;
 *   - `SANDBOX_MODE` + `effectiveBy()` (locks `by_agent` on writes
 *     when AIBALL_MCP_MODE=sandbox, per #B.63);
 *   - `microStatus()` — the "is anything waiting" probe injected
 *     into every tool response;
 *   - `asText()` — wraps a payload (+ microStatus) into the MCP
 *     `{ content: [{type:"text", text:JSON}] }` shape.
 */
import { AiballClient } from "../client.js";

export const client = new AiballClient();

/**
 * Hardened sandbox mode (#B.63). When AIBALL_MCP_MODE=sandbox is set,
 * the server locks `by_agent` on every write to the resolved agent
 * id — preventing an autonomous sub-agent from impersonating the
 * human, another agent, or a fabricated identity. Whatever the agent
 * passes in the param is ignored. Normal mode (unset) keeps the
 * previous behavior where `by_agent` is an optional override.
 */
export const SANDBOX_MODE = process.env.AIBALL_MCP_MODE === "sandbox";

export function effectiveBy(provided: string | undefined): string {
    if (SANDBOX_MODE) return client.agentId;
    return provided ?? client.agentId;
}

/**
 * Lightweight "is anything waiting for me" probe injected into every
 * tool response so the agent always sees, in passing, whether they
 * should call `unread` / `unread({ pings: true })` or check on their
 * own pending tickets. Three cheap GETs (one count each). Failures
 * degrade silently — the tool result is still valid.
 */
export async function microStatus(): Promise<{
    unread_project: number;
    unread_pings: number;
    my_pending: number;
    project: string | null;
}> {
    const proj = client.defaultProject;
    const [pjCount, pgCount, mpCount] = await Promise.all([
        proj
            ? client
                .unreadCount(proj)
                .then((r) => r.count ?? 0)
                .catch(() => 0)
            : Promise.resolve(0),
        client
            .pingsCount()
            .then((r) => r.unread ?? 0)
            .catch(() => 0),
        client
            .myPendingCount()
            .then((r) => r.count ?? 0)
            .catch(() => 0),
    ]);
    return {
        unread_project: pjCount,
        unread_pings: pgCount,
        my_pending: mpCount,
        project: proj,
    };
}

export async function asText(v: unknown) {
    const status = await microStatus();
    let payload: unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
        payload = { _status: status, ...(v as Record<string, unknown>) };
    } else {
        payload = { _status: status, result: v };
    }
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}
