/**
 * #2201 — which MCP function tools each type of agent is shown.
 *
 * david (`dz4vzc`, `tvg8x3`): gate the MCP tools by agent type, because posing
 * the guard is a discipline signal. A tool that is not registered does not exist
 * for the agent — no description in its context, nothing to call. The HTTP
 * routes stay reachable: this states what an agent is for, it is not a security
 * boundary.
 *
 * Every tool MUST appear in the table. It is the one place where "who sees this
 * tool" is decided, and a test fails for any registered tool missing from it —
 * adding a tool without deciding its audience cannot pass by accident. On the
 * day this landed every tool is shown to both types: the analysis in #2195 found
 * a steering agent needs 21 of the 25, and no steering-only tool existed yet.
 *
 * Import-free (no daemon, no database): loaded by the MCP process.
 */
export type AgentType = "coder" | "cto";
export const DEFAULT_AGENT_TYPE: AgentType = "coder";
export type AudienceTable = Readonly<Record<string, readonly AgentType[]>>;

const BOTH: readonly AgentType[] = ["coder", "cto"];

export const TOOL_AUDIENCE: AudienceTable = {
    // inbox
    unread: BOTH,
    arbitrage: BOTH,
    poll: BOTH,
    // subscriptions
    subscribe: BOTH,
    unsubscribe: BOTH,
    // tickets — write
    ticket_new: BOTH,
    ticket_reply: BOTH,
    ticket_update: BOTH,
    ticket_close: BOTH,
    ticket_decide: BOTH,
    ticket_move: BOTH,
    ticket_claim: BOTH,
    ticket_release: BOTH,
    // tickets — read
    ticket_list: BOTH,
    ticket_get: BOTH,
    search: BOTH,
    ticket_neighbors: BOTH,
    graph_audit: BOTH,
    // relations
    ticket_relate: BOTH,
    ticket_unrelate: BOTH,
    // upstream — ALSO gated on a binding + project ownership in mcp.ts
    ticket_import: BOTH,
    ticket_export: BOTH,
    // misc
    upload: BOTH,
    welcome: BOTH,
    welcome_template: BOTH,
};

/** Anything but an explicit `cto` reads as the default: an unknown value must
 *  never hide tools from an agent that was working yesterday. */
export function normalizeAgentType(v: unknown): AgentType {
    return v === "cto" ? "cto" : DEFAULT_AGENT_TYPE;
}

/** A tool missing from the table stays visible at runtime — silently hiding it
 *  would be worse than showing it — and the coverage test is what fails. */
export function isToolVisible(tool: string, type: AgentType, table: AudienceTable = TOOL_AUDIENCE): boolean {
    const audience = table[tool];
    return audience === undefined || audience.includes(type);
}

/** A view of `server` whose `registerTool` skips what this agent type is not shown. */
export function gateServer<S extends object>(server: S, type: AgentType, table: AudienceTable = TOOL_AUDIENCE): S {
    return new Proxy(server, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "registerTool" || typeof value !== "function") return value;
            return (name: string, ...rest: unknown[]) =>
                isToolVisible(name, type, table) ? value.call(target, name, ...rest) : undefined;
        },
    });
}
