/**
 * #3356 — `agent.<id>.backlog`: an agent's backlog as the picker sees it, and
 * an event naming the tickets whose place in it changed — a backlog wake that
 * sinks one (`backlog.record_wake`), a rest that ends, a ticket that changed
 * tier, came in or left. The counters only speak when the NUMBER changes, and
 * only for an agent someone keeps them for; a client watching an agent that
 * has no loop (stopped on the host) heard nothing.
 *
 * Computed only while subscribed (one watch per agent, however many
 * subscribers): it is the backlog query, a few hundred milliseconds on a real
 * board, redone on the agent's project's ticket events (debounced), on a wake
 * recorded for it, and when its earliest rest ends.
 */
import { defineSubject, publish, type Subscription } from "../subscriptions.js";
import { Refusal, type Caller } from "../methods.js";
import { getConsumer } from "../../db.js";
import { listTicketsFor } from "../../queries/tickets.js";
import { agentCooldownSec } from "../../agent-cooldown.js";
import { onLifecycle } from "../../event-bus.js";

interface Place { tier: number | null; cooled_until: string | null }
interface Watch { count: number; places: Map<number, Place>; project: string | null; restTimer: NodeJS.Timeout | null; debounce: NodeJS.Timeout | null }

const watches = new Map<string, Watch>();
const DEBOUNCE_MS = 1000;

/** The agent's backlog now: each ticket's tier and rest. */
function readPlaces(agent: string): { project: string | null; places: Map<number, Place> } {
    const project = getConsumer(agent)?.project ?? null;
    const query: Record<string, string> = { backlog: "1", limit: "500", cooldown_sec: String(agentCooldownSec(agent)) };
    if (project) query.project = project;
    const rows = listTicketsFor(agent, query, { noClaimHint: false });
    const places = new Map<number, Place>();
    for (const r of Array.isArray(rows) ? rows as Array<{ id: number; backlog_tier?: number | null; backlog_cooled_until?: string | null }> : []) {
        places.set(r.id, { tier: r.backlog_tier ?? null, cooled_until: r.backlog_cooled_until ?? null });
    }
    return { project, places };
}

function view(w: Watch) {
    return { project: w.project, backlog: [...w.places].map(([id, p]) => ({ id, ...p })) };
}

/** Read the backlog again; publish the tickets whose place changed; arm the next rest's end. */
function refresh(agent: string): void {
    const w = watches.get(agent);
    if (!w) return;
    const now = readPlaces(agent);
    const changed: number[] = [];
    for (const [id, p] of now.places) {
        const before = w.places.get(id);
        if (!before || before.tier !== p.tier || before.cooled_until !== p.cooled_until) changed.push(id);
    }
    for (const id of w.places.keys()) if (!now.places.has(id)) changed.push(id);
    w.places = now.places;
    w.project = now.project;
    armRestEnd(agent, w);
    if (changed.length) publish(`agent.${agent}.backlog`, { project: w.project, changed: changed.sort((a, b) => a - b) });
}

function armRestEnd(agent: string, w: Watch): void {
    if (w.restTimer) clearTimeout(w.restTimer);
    w.restTimer = null;
    let next: number | null = null;
    for (const p of w.places.values()) {
        const at = p.cooled_until ? Date.parse(p.cooled_until) : NaN;
        if (Number.isFinite(at) && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    w.restTimer = setTimeout(() => refresh(agent), Math.max(0, next - Date.now()) + 1000);
    w.restTimer.unref?.();
}

/** Something moved `agent`'s backlog (a wake recorded for it): read it again now, when watched. */
export function backlogTouched(agent: string): void {
    if (watches.has(agent)) refresh(agent);
}

// A ticket event in a watched agent's project: read its backlog again, once the burst is over.
onLifecycle((ev) => {
    const projects = new Set([(ev.message as { project?: string | null }).project, ev.old_project].filter((p): p is string => !!p));
    for (const [agent, w] of watches) {
        if (w.project && !projects.has(w.project)) continue;
        if (w.debounce) clearTimeout(w.debounce);
        w.debounce = setTimeout(() => { w.debounce = null; refresh(agent); }, DEBOUNCE_MS);
        w.debounce.unref?.();
    }
});

function watch(agent: string): Watch {
    let w = watches.get(agent);
    if (!w) {
        const now = readPlaces(agent);
        w = { count: 0, places: now.places, project: now.project, restTimer: null, debounce: null };
        watches.set(agent, w);
        armRestEnd(agent, w);
    }
    w.count++;
    return w;
}

function unwatch(agent: string): void {
    const w = watches.get(agent);
    if (!w || --w.count > 0) return;
    if (w.restTimer) clearTimeout(w.restTimer);
    if (w.debounce) clearTimeout(w.debounce);
    watches.delete(agent);
}

const agentOf = (sub: Subscription) => sub.parts[1];

defineSubject({
    pattern: "agent.*.backlog",
    doc: {
        value: "{ project, backlog: [{ id, tier, cooled_until }] }: the agent's backlog as the picker sees it",
        event: "{ project, changed: [ids] }: the tickets whose place changed (sunk by a wake, out of their rest, another tier, in or out)",
    },
    access: (caller: Caller) => ["human", "agent"].includes(caller.kind) ? null : new Refusal(403, "a consumer's subject"),
    setup: (sub) => {
        if (sub.state.watching) return;
        watch(agentOf(sub));
        sub.state.watching = true;
    },
    value: (sub) => view(watches.get(agentOf(sub))!),
    release: (sub) => {
        if (sub.state.watching) unwatch(agentOf(sub));
    },
});

/** Tests only. */
export function resetBacklogWatchesForTests(): void {
    for (const agent of [...watches.keys()]) {
        const w = watches.get(agent)!;
        w.count = 1;
        unwatch(agent);
    }
}
