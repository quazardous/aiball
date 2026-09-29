/**
 * #3133 — an agent's counters, computed by the daemon: `open` (open tickets in
 * its project), `actionable` (those in its court), `backlog` (what the backlog
 * picker could hand it now, cooled-down threads left out) and `events` (its
 * unread pings). The same numbers its loop used to fetch with three requests,
 * now for every agent, loop or not.
 *
 * Computed only when something that moves them happened: a ticket's lifecycle
 * (created, decided, edited, moved, tagged…) marks the agents concerned — the
 * project's owners, the agents whose loop works in it, the ticket's holder —
 * and a ping written or read marks its recipient. At most one computation per
 * agent every few seconds; published (`agent.<id>.state`, and the loop's own
 * `agent.<id>.events`) only when a number changed. What moves with time alone
 * (a snooze lapsing, a cooldown ending) waits for a client to ask
 * (`consumer.counters`).
 */
import { agentCooldownSec } from "./agent-cooldown.js";
import { onLifecycle } from "./event-bus.js";
import { onPingsChanged, unreadPingCount } from "./db/pings.js";
import { getConsumer, listConsumers } from "./db/consumers.js";
import { listProjectSubscribers } from "./db/subscriptions.js";
import { listProjectsDetailed } from "./db/projects.js";
import { listTicketsFor } from "./queries/tickets.js";
import { broadcast } from "./ws.js";
import { isPresent } from "./live-presence.js";

export interface AgentCounters {
    open: number;
    actionable: number;
    backlog: number;
    events: number;
    computed_at: string;
}

/** The backlog picker's cooldown, as a loop asks it by default. */
// #3321 — the rest the agent's own loop applies (`agent-cooldown.ts`), not an assumed hour.
/** At most one computation per agent in this span; a burst is one. Read each
 *  time (env-overridable, tiny in tests). */
function gapMs(): number {
    return Number(process.env.AIBALL_COUNTERS_GAP_MS ?? 5000);
}

const cache = new Map<string, AgentCounters>();
const timers = new Map<string, NodeJS.Timeout>();
const lastRun = new Map<string, number>();
const listeners = new Map<string, Set<(c: AgentCounters) => void>>();

/** Compute `agent`'s counters now, from the board as it stands. */
export function computeCounters(agent: string): AgentCounters {
    const project = getConsumer(agent)?.project ?? null;
    const projects = listProjectsDetailed(agent);
    const mine = project ? projects.filter((p) => p.name === project) : projects;
    const open = mine.reduce((n, p) => n + (p.open_count ?? 0), 0);
    const actionable = mine.reduce((n, p) => n + (p.actionable_count ?? 0), 0);
    const query: Record<string, string> = { backlog: "1", limit: "500", cooldown_sec: String(agentCooldownSec(agent)) };
    if (project) query.project = project;
    // #3312 — the agent's own standing (`can_claim` on its row), not a no-claim hint:
    // with the hint, every unassigned ticket left the count, whoever the agent.
    const rows = listTicketsFor(agent, query, { noClaimHint: false });
    const backlog = Array.isArray(rows)
        ? (rows as Array<{ backlog_cooled_until?: string | null }>).filter((t) => !t.backlog_cooled_until).length
        : 0;
    return { open, actionable, backlog, events: unreadPingCount(agent), computed_at: new Date().toISOString() };
}

const same = (a: AgentCounters | undefined, b: AgentCounters) =>
    !!a && a.open === b.open && a.actionable === b.actionable && a.backlog === b.backlog && a.events === b.events;

/** Compute now, keep, and tell who listens when a number changed. */
export function refreshCounters(agent: string): AgentCounters {
    const pending = timers.get(agent);
    if (pending) clearTimeout(pending);
    timers.delete(agent);
    const queued = queue.indexOf(agent);
    if (queued >= 0) queue.splice(queued, 1);
    lastRun.set(agent, Date.now());
    const next = computeCounters(agent);
    const prev = cache.get(agent);
    cache.set(agent, next);
    if (!same(prev, next)) {
        for (const fn of listeners.get(agent) ?? []) {
            try { fn(next); } catch { /* a listener never breaks the others */ }
        }
        broadcast({ type: "consumer_changed", data: { consumer_id: agent, counters: next } });
    }
    return next;
}

/** The counters last computed for `agent`, or null before the first. Computes nothing. */
export function cachedCounters(agent: string): AgentCounters | null {
    return cache.get(agent) ?? null;
}

/**
 * One computation costs a few hundred milliseconds on a real board, and the
 * daemon serves one caller at a time: the ones due run one after the other,
 * with a pause between, so a burst (the first read of every agent) is spread
 * rather than holding the daemon for seconds.
 */
const QUEUE_PAUSE_MS = 50;
const queue: string[] = [];
let draining = false;
function drain(): void {
    const agent = queue.shift();
    if (agent === undefined) {
        draining = false;
        return;
    }
    draining = true;
    try { refreshCounters(agent); } catch { /* the next event tries again */ }
    setTimeout(drain, QUEUE_PAUSE_MS).unref?.();
}

/**
 * #3272 — counters are kept for the agents someone reads them for: a loop
 * listening to its own (`onCounters`), or an agent present on the board. Of 54
 * agents on a real board, 5 were; the others (dormant, test, no project — the
 * dearest, a whole-board backlog each) were recomputed on every post anyway,
 * and that held the daemon for seconds. An absent agent's cached value is
 * dropped instead: it would only go stale, and `consumer.counters` computes
 * it when asked.
 */
function kept(agent: string): boolean {
    return (listeners.get(agent)?.size ?? 0) > 0 || isPresent(agent);
}

/** Something moved `agent`'s counters: compute them again, soon — if anyone reads them. */
export function markCountersDirty(agent: string): void {
    if (!kept(agent)) {
        cache.delete(agent);
        return;
    }
    if (timers.has(agent) || queue.includes(agent)) return;
    const since = Date.now() - (lastRun.get(agent) ?? 0);
    const delay = Math.max(0, gapMs() - since);
    const t = setTimeout(() => {
        timers.delete(agent);
        queue.push(agent);
        if (!draining) drain();
    }, delay);
    t.unref?.();
    timers.set(agent, t);
}

/** `agent`'s counters as they change (the loop's own event stream). */
export function onCounters(agent: string, fn: (c: AgentCounters) => void): () => void {
    if (!listeners.has(agent)) listeners.set(agent, new Set());
    listeners.get(agent)!.add(fn);
    return () => {
        listeners.get(agent)?.delete(fn);
        if (listeners.get(agent)?.size === 0) listeners.delete(agent);
    };
}

/** The agents a ticket's change concerns: its project's owners, the agents working in it, its holder. */
function agentsConcerned(project: string, holders: Array<string | null | undefined>): Set<string> {
    const out = new Set<string>();
    const agents = new Set(listConsumers().filter((c) => c.kind === "agent").map((c) => c.consumer_id));
    for (const id of listProjectSubscribers(project, { roles: ["owner"] })) if (agents.has(id)) out.add(id);
    for (const c of listConsumers()) if (c.kind === "agent" && c.project === project) out.add(c.consumer_id);
    for (const h of holders) if (h && agents.has(h)) out.add(h);
    return out;
}

onLifecycle((ev) => {
    const m = ev.message as { project?: string | null; assignee?: string | null; claimant?: string | null };
    const projects = [m.project, ev.old_project].filter((p): p is string => !!p);
    for (const project of projects) {
        for (const agent of agentsConcerned(project, [m.assignee, m.claimant])) markCountersDirty(agent);
    }
});

onPingsChanged((recipient) => {
    if (recipient) {
        if (getConsumer(recipient)?.kind === "agent") markCountersDirty(recipient);
        return;
    }
    // Anyone's: the agents already counted.
    for (const agent of cache.keys()) markCountersDirty(agent);
});

/** Tests only. */
export function resetCountersForTests(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    queue.length = 0;
    cache.clear();
    lastRun.clear();
    listeners.clear();
}
