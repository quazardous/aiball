/**
 * #2180 — set a loop agent's type (`coder` / `cto`) BEFORE its claude session
 * starts.
 *
 * The MCP server reads the agent type once, at boot (#2201), but the consumer
 * record only used to exist once the agent had talked to the daemon. So a new
 * agent always booted as `coder`, and making it a `cto` meant: launch, set the
 * type, restart. `claude-loop start --type cto` closes that gap by creating the
 * record when needed and setting the type first.
 *
 * The record is created ONLY when it does not exist. `POST /api/consumers`
 * resets every field it is not sent — an existing agent would lose its display
 * name and note, and a disabled one would come back enabled — so an existing
 * record is never posted to; only its type is patched.
 *
 * Setting a type is a human gesture (the daemon refuses it from an agent), so
 * this runs with the local human identity — the same local trust as
 * `aiball --human`. Against a remote daemon holding only an agent token that is
 * refused: the loop still starts, and the caller gets a warning saying how to
 * set the type instead. Never throws, never blocks the spawn.
 */
export type AgentType = "coder" | "cto";

export interface HumanConsumerClient {
    getConsumer(id: string): Promise<unknown>;
    upsertConsumer(input: { consumer_id: string; kind?: "agent" }): Promise<unknown>;
    patchConsumer(id: string, patch: { agent_type: AgentType }): Promise<unknown>;
}

export type AgentTypeVerdict = { ok: true } | { ok: false; warning: string };

const notFound = (e: unknown) => /\b404\b|not found/i.test(e instanceof Error ? e.message : String(e));

/** Create the record only when the daemon says it does not exist. */
export async function ensureConsumerRecord(client: Pick<HumanConsumerClient, "getConsumer" | "upsertConsumer">, id: string): Promise<void> {
    try {
        await client.getConsumer(id);
    } catch (e) {
        if (!notFound(e)) throw e;
        await client.upsertConsumer({ consumer_id: id, kind: "agent" });
    }
}

export async function applyAgentType(opts: {
    agentId: string;
    type: AgentType;
    human: HumanConsumerClient;
}): Promise<AgentTypeVerdict> {
    try {
        await ensureConsumerRecord(opts.human, opts.agentId);
        await opts.human.patchConsumer(opts.agentId, { agent_type: opts.type });
        return { ok: true };
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const refused = /\b403\b|human-only/i.test(m);
        return {
            ok: false,
            warning: refused
                ? `agent type not set: the daemon only lets a human set it. Run \`aiball --human agent set ${opts.agentId} --type ${opts.type}\` on the daemon host, or use the agent's page in the UI, then restart the loop.`
                : `agent type not set (${m}). The loop starts as \`coder\`; set it with \`aiball --human agent set ${opts.agentId} --type ${opts.type}\`, then restart the loop.`,
        };
    }
}
