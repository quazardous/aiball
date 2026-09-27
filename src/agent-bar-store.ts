/**
 * The latest loop bar each agent pushed (see `agent-bar.ts`), in memory: it is
 * live state, like presence, and means nothing after a daemon restart — the
 * loops push again on their next change.
 *
 * A bar is `stale` once its loop is no longer present: the same signal as the
 * `running` flag (the loop's event stream closed, past the reconnect grace), so a
 * dead loop never shows as busy. A host is told on the bus (`agent.<id>.bar`)
 * when a bar changes, goes stale, or is live again.
 */
import type { AgentBar } from "./agent-bar.js";
import { isPresent, onPresenceStart, onPresenceStop } from "./live-presence.js";
import { broadcast } from "./ws.js";

interface Entry { bar: AgentBar; json: string; updatedAt: string }
const bars = new Map<string, Entry>();

export interface AgentBarView {
    consumer_id: string;
    bar: AgentBar;
    updated_at: string;
    stale: boolean;
}

function view(consumer: string, e: Entry): AgentBarView {
    return { consumer_id: consumer, bar: e.bar, updated_at: e.updatedAt, stale: !isPresent(consumer) };
}

/** Keep `bar` as `consumer`'s latest. True when it differs from the one kept
 *  (then hosts are told); an identical push only refreshes `updated_at`. */
export function setAgentBar(consumer: string, bar: AgentBar, nowIso = new Date().toISOString()): boolean {
    const json = JSON.stringify(bar);
    const prev = bars.get(consumer);
    bars.set(consumer, { bar, json, updatedAt: nowIso });
    if (prev && prev.json === json) return false;
    broadcast({ type: "agent_bar", data: view(consumer, bars.get(consumer)!) });
    return true;
}

/** `consumer`'s latest bar, or null when it never pushed one. */
export function getAgentBar(consumer: string): AgentBarView | null {
    const e = bars.get(consumer);
    return e ? view(consumer, e) : null;
}

// A loop that stopped: its bar goes stale, and hosts hear it at once.
onPresenceStop((consumer) => {
    const e = bars.get(consumer);
    if (e) broadcast({ type: "agent_bar", data: view(consumer, e) });
});

// #3133 — and one that is back: the bar it left is live again (stale: false).
onPresenceStart((consumer) => {
    const e = bars.get(consumer);
    if (e) broadcast({ type: "agent_bar", data: view(consumer, e) });
});

/** #3063 — every agent's latest bar. */
export function listAgentBars(): AgentBarView[] {
    return [...bars.entries()].map(([consumer, e]) => view(consumer, e));
}

/** Tests only. */
export function __resetAgentBars(): void {
    bars.clear();
}
