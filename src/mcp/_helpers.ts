/**
 * Shared helpers for the aiball MCP server's tool clusters (carved
 * out of src/mcp.ts in #B.213 phase 4.A on 2026-05-19). Behavior-
 * preserving move.
 *
 * Holds:
 *   - the singleton `AiballClient` used by every tool;
 *   - `effectiveBy()` — locks `by_agent` on every write to the
 *     resolved agent id (#240; was sandbox-only per #B.63);
 *   - `microStatus()` — the "is anything waiting" probe injected
 *     into every tool response;
 *   - `asText()` — wraps a payload (+ microStatus) into the MCP
 *     `{ content: [{type:"text", text:JSON}] }` shape.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiballClient } from "../client.js";

export const client = new AiballClient();

/**
 * #404: record the ticket the agent is currently focused on (the last
 * ticket-scoped tool call), so the claude-loop Stop-hook can attribute the
 * turn's token usage to it. Writes `active-ticket` in the loop state dir.
 * Best-effort + a no-op outside a claude-loop session (no `CL_STATE_DIR`),
 * so the generic MCP (direct / non-loop use) is unaffected.
 */
export function markActiveTicket(ticketId: number | null | undefined): void {
    const sd = process.env.CL_STATE_DIR;
    if (!sd || !ticketId || ticketId <= 0) return;
    try { writeFileSync(join(sd, "active-ticket"), String(ticketId)); } catch { /* best-effort */ }
}

/**
 * Resolve the author identity for every MCP write. The stored `by_agent`
 * is always the resolved agent id (`client.agentId`, from AIBALL_AGENT /
 * cwd hash); a caller-supplied `by_agent` is ignored.
 *
 * Why ignore it (#240): the self-ping filter in `fanOutPings`
 * (`src/messages.ts`) skips the author by strict `recipient === by_agent`
 * equality. A cosmetic override (e.g. "claude" while the consumer is
 * "skybot-claude") mismatches that equality, so the agent received its
 * own comments back as personal pings. Locking the author to the consumer
 * id closes the drift. Previously this lock was opt-in via
 * AIBALL_MCP_MODE=sandbox (#B.63); #240 made it the only behavior.
 */
export function effectiveBy(_provided?: string): string {
    return client.agentId;
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
