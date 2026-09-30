/** #3063 — consumers: the list, an agent's backlog and bar, the loop controls on it. */
import { agentCooldownSec } from "../../agent-cooldown.js";
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { flag } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import { deleteConsumer, getConsumer, isHuman, listConsumers, pingCountsByConsumer, updateConsumer, upsertConsumer, type Consumer, type ConsumerKind } from "../../db.js";
import { spoolPrompt, drainPrompts } from "../../loop-prompts.js";
import { pickHoldTargets, type LoopHoldResult } from "../../loop-hold.js";
import { AGENT_TYPES, type AgentType } from "../../db/consumers.js";
import { broadcast } from "../../ws.js";
import { cachedCounters, markCountersDirty, refreshCounters } from "../../agent-counters.js";
import { sessionFor, tmuxSessionView, viewOf } from "../../sessions/registry.js";
import { isPresent, presenceMachine, presenceRunning } from "../../live-presence.js";
import { machineName } from "../../machine-name.js";
import { emitControl } from "../../event-bus.js";
import { listWaitCreditMoves, listWaitCredits, waitCreditBalance, waitCreditEnabled, type WaitCreditRow } from "../../db/wait-credit.js";
import { unreadPingCount } from "../../db/pings.js";
import { listTicketsFor } from "../../queries/tickets.js";
import { getAgentBar } from "../../agent-bar-store.js";
import { isBarHost } from "../../agent-bar.js";
import { isLocalLoop, localLoopDir, sendAfkToLoop, sendControlToLoop } from "./loop-afk.js";
import { fetchLiveLoopStateUds } from "../../claude-loop/hook-verdict.js";
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

/**
 * #3293 — answered by a proxy node: a loop control is for a loop of its own
 * machine, reached through the loop's socket (the loop's bus connection goes
 * to the upstream, not here).
 */
const onNode = (caller: Caller): boolean => caller.node === true;

/** #3293 — the refusal a socket send could not reach its loop with. */
function refuseUnreached(r: { ok: false; status: number; error: string; code: import("../../domain.js").ErrorCode }): never {
    throw new Refusal(r.status, r.error, r.code);
}

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
 * its live presence (#443), the machine its loop runs on (#3412: `hub`,
 * `node:<label>`, `tcp:<address>`, null without a loop), its ping tally (#1185), each agent's wait credit
 * per project (#2645), its session — on the host (#3066) or in tmux (#3135) —
 * or null, and
 * an agent's counters (#3133): the last computed, null before the first. An
 * agent whose loop runs, or that has a session, has them computed then and
 * pushed on `agent.<id>.state`; the others wait for an event that concerns
 * them, or `consumer.counters`.
 */
function consumerEntry(c: Consumer, ctx: ReturnType<typeof entryContext>) {
    const session = sessionFor({ agent: c.consumer_id });
    const counters = c.kind === "agent" ? cachedCounters(c.consumer_id) : null;
    if (c.kind === "agent" && !counters && (session || isPresent(c.consumer_id))) markCountersDirty(c.consumer_id);
    return {
        ...c,
        present: presenceRunning(c.consumer_id),
        // #3412 — where its loop runs now, in the words `bus.whoami` says the caller's machine in.
        machine: machineName(presenceMachine(c.consumer_id)),
        ping_count: ctx.pings.get(c.consumer_id)?.total ?? 0,
        ping_unseen: ctx.pings.get(c.consumer_id)?.unseen ?? 0,
        wait_credit: c.kind === "human" ? null : (ctx.credits.get(c.consumer_id) ?? []),
        // #3135 — on the host, its session; in tmux, where to reach the loop.
        session: session ? viewOf(session) : c.kind === "agent" ? tmuxSessionView(c.consumer_id) : null,
        counters,
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
        // #3321 — without a `cooldown_sec`, the rest the agent's own loop applies.
        const query: Record<string, string> = { backlog: "1", cooldown_sec: String(agentCooldownSec(p.consumer_id)) };
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
 *
 * #3117 — `when_idle`: ordered while Claude works, the restart is held by the
 * loop until its next idle, however long; its bar says `alerts.restart_pending`
 * meanwhile, and a second order changes nothing.
 */
defineMethod({
    name: "consumer.restart_claude",
    ...LOOP_CONTROL,
    nodeLocal: (p) => isLocalLoop((p as { name?: unknown }).name),
    params: z.object({ name: z.string(), when_idle: flag }),
    run: (caller, p) => {
        if (!p.name || p.name.length > MAX_NAME_LEN || !/^[A-Za-z0-9._-]+$/.test(p.name)) throw new Refusal(400, "bad consumer id");
        const whenIdle = p.when_idle === true;
        if (onNode(caller)) return restartOnNode(p.name, whenIdle);
        if (!isPresent(p.name)) throw new Refusal(404, `no running claude-loop answers for ${p.name}`, ERROR_CODES.LOOP_NOT_FOUND);
        const phase = getAgentBar(p.name)?.bar.phase;
        if (!whenIdle && phase !== "idle") {
            throw new Refusal(409, `Claude is ${phase ?? "in an unknown state"}: a restart waits until it is idle (or pass when_idle)`, ERROR_CODES.NOT_IDLE);
        }
        emitControl(p.name, { action: "restart_claude", ...(whenIdle ? { when_idle: true } : {}) });
        return { consumer_id: p.name, queued: true, ...(whenIdle ? { when_idle: true } : {}) };
    },
});

/** #3293 — `consumer.restart_claude` answered by a proxy node, for a loop of its machine. */
async function restartOnNode(name: string, whenIdle: boolean): Promise<{ consumer_id: string; queued: boolean; when_idle?: true }> {
    // The loop's own state, asked on its socket: the node holds no bar.
    const where = localLoopDir(name);
    if (!where.ok) refuseUnreached(where);
    const live = await fetchLiveLoopStateUds(where.sd, 1000);
    if (!live) throw new Refusal(404, `no running claude-loop answers for ${name}`, ERROR_CODES.LOOP_NOT_FOUND);
    if (!whenIdle && (live.paneBusy || !live.paneReady)) {
        throw new Refusal(409, `Claude is ${live.paneBusy ? "busy" : "not ready"}: a restart waits until it is idle (or pass when_idle)`, ERROR_CODES.NOT_IDLE);
    }
    const sent = await sendControlToLoop(name, { action: "restart_claude", ...(whenIdle ? { when_idle: true } : {}) });
    if (!sent.ok) refuseUnreached(sent);
    return { consumer_id: name, queued: sent.delivered, ...(whenIdle ? { when_idle: true as const } : {}) };
}

/** #3293 — a loop control sent by a proxy node to a loop of its machine: the answer it gives. */
async function controlOnNode<T>(consumerId: string, control: Parameters<typeof sendControlToLoop>[1], answer: (delivered: boolean) => T): Promise<T> {
    const sent = await sendControlToLoop(consumerId, control);
    if (!sent.ok) refuseUnreached(sent);
    return answer(sent.delivered);
}

/** #2333 — hold or release an agent's loop (AFK), as its own keys would. */
defineMethod({
    name: "consumer.afk",
    ...LOOP_CONTROL,
    // #3284 — through the loop's local socket: the machine the loop runs on.
    relayed: true,
    machine: true,
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
        const before = patch.can_claim !== undefined ? getConsumer(p.consumer_id)?.can_claim : undefined;
        const updated = updateConsumer(p.consumer_id, patch);
        if (!updated) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        // #3312 — every change of a claim right says who made it.
        if (before !== undefined && before !== updated.can_claim) {
            console.log(`[standing] ${p.consumer_id}: can_claim ${before} -> ${updated.can_claim}, by ${caller.consumer_id ?? "?"} (${caller.machine ?? caller.transport})`);
        }
        broadcast({ type: "consumer_changed", data: updated });
        return updated;
    },
});

/** The caller's own record: who the page is logged in as. */
defineMethod({
    name: "consumer.me",
    who: ["human", "agent"],
    params: z.object({}),
    run: (caller) => {
        const c = getConsumer(consumerIdOf(caller));
        if (!c) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        return c;
    },
});

/** #2645 — an agent's wait credit, per project, and its latest movements (`limit`, 30 by default). A human has none. */
defineMethod({
    name: "consumer.wait_credit",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string(), limit: z.coerce.number().optional() }),
    run: (_c, p) => {
        const c = getConsumer(p.consumer_id);
        if (!c) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        if (c.kind === "human") return { consumer_id: c.consumer_id, credits: null, moves: [] };
        return {
            consumer_id: c.consumer_id,
            credits: listWaitCredits().filter((r) => r.consumer_id === c.consumer_id),
            moves: listWaitCreditMoves(c.consumer_id, p.limit !== undefined && Number.isFinite(p.limit) ? p.limit : 30),
        };
    },
});

/** Delete a consumer's record. */
defineMethod({
    name: "consumer.delete",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string() }),
    run: (_c, p) => {
        if (!getConsumer(p.consumer_id)) throw new Refusal(404, "consumer not found", ERROR_CODES.CONSUMER_NOT_FOUND);
        deleteConsumer(p.consumer_id);
        broadcast({ type: "consumer_changed", data: { consumer_id: p.consumer_id, deleted: true } });
        return { consumer_id: p.consumer_id, deleted: true };
    },
});

/**
 * #442 — stop the claude-loop running as this consumer, from afar: a
 * `control:kill` its loop receives. `delivered` says whether a loop was
 * connected to hear it (false: nothing was running).
 */
defineMethod({
    name: "consumer.stop_loop",
    ...LOOP_CONTROL,
    nodeLocal: (p) => isLocalLoop((p as { consumer_id?: unknown }).consumer_id),
    params: z.object({ consumer_id: z.string() }),
    run: (caller, p) => {
        // #3293 — a loop of the node's machine, through its socket.
        if (onNode(caller)) return controlOnNode(p.consumer_id, { action: "kill" }, (delivered) => ({ consumer_id: p.consumer_id, action: "kill", delivered }));
        const delivered = isPresent(p.consumer_id);
        emitControl(p.consumer_id, { action: "kill" });
        return { consumer_id: p.consumer_id, action: "kill", delivered };
    },
});

/**
 * #451 — spool a prompt for a loop, in the daemon's memory only, then flush the
 * whole queue if the loop is live; otherwise it waits for the loop to connect.
 * Returns whether it went now.
 */
function deliverLoopPrompt(target: string, text: string): boolean {
    spoolPrompt(target, text);
    const present = isPresent(target);
    if (present) {
        for (const t of drainPrompts(target)) emitControl(target, { action: "prompt", text: t });
    }
    return present;
}

/**
 * #451 — a raw prompt typed into the loop's Claude session, as a wake would
 * be, unfiltered: a moderator's gesture, never a proxy node's (a prompt can
 * steer the agent). Always spooled; `delivered` when a live loop took it now.
 */
defineMethod({
    name: "consumer.prompt",
    ...LOOP_CONTROL,
    nodeLocal: (p) => isLocalLoop((p as { consumer_id?: unknown }).consumer_id),
    params: z.object({ consumer_id: z.string(), text: z.unknown().optional() }),
    run: (caller, p) => {
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (!text) throw new Refusal(400, "text required");
        // #3293 — straight to a loop of the node's machine: not spooled, the loop is here.
        if (onNode(caller)) return controlOnNode(p.consumer_id, { action: "prompt", text }, (delivered) => ({ consumer_id: p.consumer_id, action: "prompt", spooled: false, delivered }));
        return { consumer_id: p.consumer_id, action: "prompt", spooled: true, delivered: deliverLoopPrompt(p.consumer_id, text) };
    },
});

/** #2333 — the agent loops an all-loops control reaches: the live ones, or the ones named. */
function holdTargets(requested: unknown): string[] {
    const named = Array.isArray(requested) ? requested.filter((x): x is string => typeof x === "string") : null;
    return pickHoldTargets(
        listConsumers().map((c) => ({ consumer_id: c.consumer_id, kind: c.kind, present: presenceRunning(c.consumer_id) })),
        named,
    );
}

/**
 * #2333 — a message to every agent loop running here (or the ones named),
 * typed into each session at once; with `hold`, each loop is then held (NOT
 * AFK ∞) so no wake starts new work while the operator is away. One line per
 * loop in the daemon's log and in the answer.
 */
defineMethod({
    name: "loops.message_all",
    ...LOOP_CONTROL,
    params: z.object({ message: z.unknown().optional(), hold: z.unknown().optional(), consumers: z.unknown().optional() }),
    run: (_c, p) => {
        const message = typeof p.message === "string" ? p.message.trim() : "";
        if (!message) throw new Refusal(400, "message required");
        const hold = p.hold === true;
        const results: LoopHoldResult[] = holdTargets(p.consumers).map((consumer_id) => {
            const delivered = deliverLoopPrompt(consumer_id, message);
            const result: LoopHoldResult = { consumer_id, prompt: delivered ? "delivered" : "spooled" };
            if (hold) {
                const held = sendAfkToLoop(consumer_id, "arm_inf");
                result.hold = held.ok ? "armed" : "failed";
                if (!held.ok) result.hold_error = held.error;
            }
            console.error(`[loops-message-all] ${consumer_id} prompt=${result.prompt}${hold ? ` hold=${result.hold}${result.hold_error ? ` (${result.hold_error})` : ""}` : ""}`);
            return result;
        });
        return { action: hold ? "message-and-hold" : "message", results };
    },
});

/** #2333 — on return: lift the hold on every agent loop, or the ones named. */
defineMethod({
    name: "loops.release_all",
    ...LOOP_CONTROL,
    params: z.object({ consumers: z.unknown().optional() }),
    run: (_c, p) => {
        const results: LoopHoldResult[] = holdTargets(p.consumers).map((consumer_id) => {
            const released = sendAfkToLoop(consumer_id, "off");
            const result: LoopHoldResult = { consumer_id, hold: released.ok ? "released" : "failed" };
            if (!released.ok) result.hold_error = released.error;
            console.error(`[loops-release-all] ${consumer_id} hold=${result.hold}${result.hold_error ? ` (${result.hold_error})` : ""}`);
            return result;
        });
        return { action: "release", results };
    },
});

/**
 * #3133 — an agent's counters, computed now: `open`, `actionable`, `backlog`,
 * `events`, as its loop's bar shows them. The daemon computes them on the
 * events that move them; this is for what moves with time alone (a snooze
 * lapsing, a backlog cooldown ending) when a client needs them right: a changed
 * number is pushed on `agent.<id>.state` too.
 */
defineMethod({
    name: "consumer.counters",
    who: ["human", "agent"],
    params: z.object({ consumer_id: z.string().min(1) }),
    run: (caller, p) => {
        ownOrHuman(caller, p.consumer_id, "counters");
        const c = getConsumer(p.consumer_id);
        if (!c) throw new Refusal(404, `no consumer ${p.consumer_id}`, ERROR_CODES.CONSUMER_NOT_FOUND);
        if (c.kind !== "agent") throw new Refusal(400, "counters are an agent's");
        return { consumer_id: p.consumer_id, ...refreshCounters(p.consumer_id) };
    },
});
