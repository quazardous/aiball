/** #3063 — consumers: the list, an agent's backlog and bar, the loop controls on it. */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { ERROR_CODES } from "../../domain.js";
import { getConsumer, isHuman, listConsumers, pingCountsByConsumer, updateConsumer, upsertConsumer, type Consumer, type ConsumerKind } from "../../db.js";
import { AGENT_TYPES, type AgentType } from "../../db/consumers.js";
import { broadcast } from "../../ws.js";
import { sessionFor, viewOf } from "../../sessions/registry.js";
import { isPresent, presenceRunning } from "../../live-presence.js";
import { emitControl } from "../../event-bus.js";
import { listWaitCredits, waitCreditBalance, waitCreditEnabled, type WaitCreditRow } from "../../db/wait-credit.js";
import { unreadPingCount } from "../../db/pings.js";
import { listTicketsFor } from "../../api/tickets.js";
import { getAgentBar } from "../../agent-bar-store.js";
import { isBarHost } from "../../agent-bar.js";
import { localLoopDir, sendAfkToLoop } from "../../api/agents.js";
import { sendEventOnce } from "../../claude-loop/ipc-events.js";
import { loopSockPath } from "../../claude-loop/state.js";

/** An agent's own data: readable by a human, or by the agent itself. */
function ownOrHuman(caller: Caller, target: string, what: string): void {
    if (target !== consumerIdOf(caller) && caller.kind !== "human") {
        throw new Refusal(403, `an agent's ${what} is readable by a human or by the agent itself`);
    }
}

/** A loop control (hold, bar host): a moderator's, never a proxy node's. */
const LOOP_CONTROL = {
    who: ["human"] as const,
    relayed: false,
    denied: { message: "loop control is moderator-only", code: ERROR_CODES.MODERATOR_ONLY },
};

/** What every entry of one read shares: the ping tallies and the wait credits of everyone. */
function entryContext() {
    const pings = pingCountsByConsumer();
    const credits = new Map<string, WaitCreditRow[]>();
    for (const row of listWaitCredits()) credits.set(row.consumer_id, [...(credits.get(row.consumer_id) ?? []), row]);
    return { pings, credits };
}

/**
 * One consumer as `consumer.list` gives it, and as `agent.<id>.state` pushes
 * it (#3070: the same builder, so the two cannot name a field differently):
 * its live presence (#443), its ping tally (#1185), each agent's wait credit
 * per project (#2645), and the session a host runs for it (#3066), or null.
 */
function consumerEntry(c: Consumer, ctx: ReturnType<typeof entryContext>) {
    const session = sessionFor({ agent: c.consumer_id });
    return {
        ...c,
        present: presenceRunning(c.consumer_id),
        ping_count: ctx.pings.get(c.consumer_id)?.total ?? 0,
        ping_unseen: ctx.pings.get(c.consumer_id)?.unseen ?? 0,
        wait_credit: c.kind === "human" ? null : (ctx.credits.get(c.consumer_id) ?? []),
        session: session ? viewOf(session) : null,
    };
}

export type ConsumerEntry = ReturnType<typeof consumerEntry>;

/** One consumer's entry, or null when it does not exist (any more). */
export function consumerEntryFor(id: string): ConsumerEntry | null {
    const c = getConsumer(id);
    return c ? consumerEntry(c, entryContext()) : null;
}

/** Every consumer's entry. */
export function consumerEntries(): ConsumerEntry[] {
    const ctx = entryContext();
    return listConsumers().map((c) => consumerEntry(c, ctx));
}

/** Every consumer, each as `consumerEntry` builds it: presence, pings, wait credit, session. */
defineMethod({
    name: "consumer.list",
    who: ["human", "agent"],
    params: z.object({}),
    run: () => consumerEntries(),
});

/**
 * An agent's backlog as its loop sees it, with its unread pings and its wait
 * credit on the project. Read-only: nothing is marked read, no wake recorded.
 */
defineMethod({
    name: "consumer.backlog",
    who: ["human", "agent"],
    params: z.object({
        consumer_id: z.string(),
        project: z.string().optional(),
        cooldown_sec: z.coerce.string().optional(),
        limit: z.coerce.string().optional(),
    }),
    run: (caller, p) => {
        ownOrHuman(caller, p.consumer_id, "backlog");
        const c = getConsumer(p.consumer_id);
        if (!c) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        const query: Record<string, string> = { backlog: "1" };
        for (const key of ["project", "cooldown_sec", "limit"] as const) {
            const v = p[key];
            if (v) query[key] = v;
        }
        // The proxy's no-claim hint is a header of the agent's own requests: absent
        // here, the agent's claimability is its database flag, as its loops see it.
        const rows = listTicketsFor(p.consumer_id, query, { noClaimHint: false });
        return {
            consumer_id: p.consumer_id,
            rows,
            unread: unreadPingCount(p.consumer_id),
            wait_credit: p.project && c.kind !== "human" && waitCreditEnabled(p.project) ? waitCreditBalance(p.consumer_id, p.project) : null,
        };
    },
});

/** #3030 — an agent's loop bar as data, for hosts other than tmux. */
defineMethod({
    name: "consumer.bar",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string() }),
    run: (caller, p) => {
        ownOrHuman(caller, p.consumer_id, "bar");
        const view = getAgentBar(p.consumer_id);
        if (!view) throw new Refusal(404, "no bar pushed by this consumer yet");
        return view;
    },
});

/**
 * #3044 — who draws an agent's bar: `tmux` (its status line) or `external`
 * (another host draws it from the bar data). Relayed to the loop, whose kernel
 * records it; the next bar pushed carries the new `host`.
 */
defineMethod({
    name: "consumer.set_bar_host",
    ...LOOP_CONTROL,
    params: z.object({ consumer_id: z.string(), host: z.unknown().optional() }),
    run: async (_c, p) => {
        if (!isBarHost(p.host)) throw new Refusal(400, "host must be tmux or external");
        const where = localLoopDir(p.consumer_id);
        if (!where.ok) throw new Refusal(where.status, where.error, where.code);
        try {
            await sendEventOnce(loopSockPath(where.sd), { kind: "proxyEvent", data: { event: "bar_host", host: p.host } }, { timeoutMs: 1000, throwOnError: true });
        } catch (e) {
            throw new Refusal(502, `the loop did not take it: ${(e as Error).message}`, ERROR_CODES.BAD_GATEWAY);
        }
        return { consumer_id: p.consumer_id, loop: where.loop, host: p.host };
    },
});

const MAX_NAME_LEN = 64;

/**
 * Restart an agent's Claude after it installed an update of itself (the bar
 * says `alerts.restart_needed`). A loop control. Refused while Claude works
 * (`NOT_IDLE`: a turn is never cut); the loop waits for idle again, restarts
 * Claude resuming its conversation, and tells the agent once it is back.
 */
defineMethod({
    name: "consumer.restart_claude",
    ...LOOP_CONTROL,
    params: z.object({ name: z.string() }),
    run: (_c, p) => {
        if (!p.name || p.name.length > MAX_NAME_LEN || !/^[A-Za-z0-9._-]+$/.test(p.name)) throw new Refusal(400, "bad consumer id");
        if (!isPresent(p.name)) throw new Refusal(404, `no running claude-loop answers for ${p.name}`, ERROR_CODES.LOOP_NOT_FOUND);
        const phase = getAgentBar(p.name)?.bar.phase;
        if (phase !== "idle") {
            throw new Refusal(409, `Claude is ${phase ?? "in an unknown state"}: a restart waits until it is idle`, ERROR_CODES.NOT_IDLE);
        }
        emitControl(p.name, { action: "restart_claude" });
        return { consumer_id: p.name, queued: true };
    },
});

/** #2333 — hold or release an agent's loop (AFK), as its own keys would. */
defineMethod({
    name: "consumer.afk",
    ...LOOP_CONTROL,
    params: z.object({ name: z.string(), action: z.unknown().optional(), durationSec: z.unknown().optional() }),
    run: (_c, p) => {
        const consumerId = p.name;
        if (!consumerId || consumerId.length > MAX_NAME_LEN || !/^[A-Za-z0-9._-]+$/.test(consumerId)) {
            throw new Refusal(400, "bad consumer id");
        }
        const action = p.action;
        if (action !== "toggle" && action !== "off" && action !== "arm_10m" && action !== "arm_inf") {
            throw new Refusal(400, "action must be one of toggle / off / arm_10m / arm_inf");
        }
        const durationSec = typeof p.durationSec === "number" && Number.isFinite(p.durationSec)
            ? Math.max(1, Math.floor(p.durationSec))
            : 600;
        const sent = sendAfkToLoop(consumerId, action, durationSec);
        if (!sent.ok) throw new Refusal(sent.status, sent.error, sent.code);
        return { consumer_id: consumerId, loop: sent.loop, action, queued: true };
    },
});

const KINDS = ["human", "agent", "sandbox"] as const;

function checkKind(kind: unknown): void {
    if (kind !== undefined && !(KINDS as readonly unknown[]).includes(kind)) {
        throw new Refusal(400, "kind must be 'human', 'agent', or 'sandbox'");
    }
}

/**
 * #B.79 — create a consumer, or update it. #2221 — an absent field leaves the
 * record's value alone (a partial call once wiped the note and re-enabled a
 * disabled agent); an explicit null clears it.
 */
defineMethod({
    name: "consumer.upsert",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.unknown(), kind: z.unknown().optional(), display_name: z.unknown().optional(), enabled: z.unknown().optional(), note: z.unknown().optional() }),
    run: (_caller, p) => {
        if (typeof p.consumer_id !== "string" || !p.consumer_id) throw new Refusal(400, "consumer_id required");
        checkKind(p.kind);
        const c = upsertConsumer({
            consumer_id: p.consumer_id,
            kind: p.kind as ConsumerKind | undefined,
            display_name: typeof p.display_name === "string" || p.display_name === null ? p.display_name : undefined,
            enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
            note: typeof p.note === "string" || p.note === null ? p.note : undefined,
        });
        broadcast({ type: "consumer_changed", data: c });
        return c;
    },
});

/**
 * Patch a consumer. #1477 — the capability fields (`can_claim`,
 * `can_create_agent`, #2201 `agent_type`) are a human's to set, never an
 * agent's: an agent flipping its own `can_claim` would make the authority
 * model decorative. The other fields stay editable by anyone.
 */
defineMethod({
    name: "consumer.update",
    who: ["human", "agent"],
    params: z.object({
        consumer_id: z.string(),
        kind: z.unknown().optional(), display_name: z.unknown().optional(), enabled: z.unknown().optional(),
        note: z.unknown().optional(), micro_prompt: z.unknown().optional(), can_claim: z.unknown().optional(),
        can_create_agent: z.unknown().optional(), agent_type: z.unknown().optional(), notify_project_broadcasts: z.unknown().optional(),
    }),
    run: (caller, p) => {
        checkKind(p.kind);
        const touchesCapability = p.can_claim !== undefined || p.can_create_agent !== undefined || p.agent_type !== undefined;
        if (touchesCapability && !isHuman(consumerIdOf(caller))) {
            throw new Refusal(403, "consumer capability fields (can_claim, can_create_agent, agent_type) are human-only — set them via the moderator UI, not from an agent", ERROR_CODES.MODERATOR_ONLY);
        }
        if (p.agent_type !== undefined && !(AGENT_TYPES as readonly unknown[]).includes(p.agent_type)) {
            throw new Refusal(400, `agent_type must be one of: ${AGENT_TYPES.join(", ")}`);
        }
        const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
        const patch: Parameters<typeof updateConsumer>[1] = {};
        if (p.kind !== undefined) patch.kind = p.kind as ConsumerKind;
        if (p.display_name !== undefined) patch.display_name = textOrNull(p.display_name);
        if (typeof p.enabled === "boolean") patch.enabled = p.enabled;
        if (p.note !== undefined) patch.note = textOrNull(p.note);
        if (p.micro_prompt !== undefined) patch.micro_prompt = textOrNull(p.micro_prompt);
        if (typeof p.can_claim === "boolean") patch.can_claim = p.can_claim;
        if (typeof p.can_create_agent === "boolean") patch.can_create_agent = p.can_create_agent;
        if (p.agent_type !== undefined) patch.agent_type = p.agent_type as AgentType;
        // #516 — tri-state: null, true or false; any other type changes nothing.
        if (p.notify_project_broadcasts === null || typeof p.notify_project_broadcasts === "boolean") {
            patch.notify_project_broadcasts = p.notify_project_broadcasts;
        }
        const updated = updateConsumer(p.consumer_id, patch);
        if (!updated) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        broadcast({ type: "consumer_changed", data: updated });
        return updated;
    },
});
