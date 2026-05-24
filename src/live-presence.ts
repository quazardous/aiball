/**
 * #395: live presence registry — near-realtime claude-loop running detection.
 *
 * The loop already holds a long-lived SSE connection to `/api/events`. Its
 * connect/disconnect IS the liveness signal — far sharper than the 120 s
 * heartbeat poll (`db/projects.ts`), which detects a STOP only once the last
 * heartbeat goes stale (up to 120 s late) and never emits an event.
 *
 * So: SSE open → present → broadcast `running:true`; SSE close → (after a short
 * grace, to tolerate reconnect blips) absent → broadcast `running:false`. The UI
 * already refetches projects on any WS event, so this lights up live.
 *
 * **Presence is authoritative over heartbeat for any consumer this daemon has
 * seen connect** — otherwise a just-dead loop with a still-fresh heartbeat would
 * read `running` for up to 120 s (the very bug we're fixing). The heartbeat
 * window survives only as a *bridge* for consumers never seen via SSE this
 * session (e.g. right after a daemon restart, before loops reconnect).
 *
 * In-memory by design: presence is process-local liveness. A daemon restart
 * clears it and re-derives from reconnects + the heartbeat bridge.
 */
import { broadcast } from "./ws.js";

export type LaunchSource = "terminal" | "ui";

interface Entry {
    /** Live SSE connections for this consumer (reconnect overlap / multi-client). */
    count: number;
    source: LaunchSource;
    /** Set while count===0 and we're waiting out the grace before declaring stop. */
    graceTimer?: ReturnType<typeof setTimeout>;
}

/** Grace before a disconnect becomes a STOP — absorbs reconnect-backoff blips.
 *  Read dynamically (env-overridable, e.g. tiny in tests). */
function graceMs(): number {
    return Number(process.env.AIBALL_PRESENCE_GRACE_MS ?? 6000);
}

const live = new Map<string, Entry>();
/** Consumers seen connect at least once this daemon session (→ presence wins). */
const everSeen = new Set<string>();

/** Emit a per-consumer running transition. `data` mirrors the heartbeat path
 *  (`consumer_changed`) so the UI's existing handler picks it up. */
function emit(consumer: string, running: boolean, source?: LaunchSource): void {
    broadcast({ type: "consumer_changed", data: { consumer_id: consumer, running, ...(source ? { source } : {}) } });
}

/** Register an SSE connection. Returns whether the consumer transitioned to
 *  live (so the caller broadcasts `running:true` only on a real edge). */
export function presenceConnect(consumer: string, source: LaunchSource = "terminal"): { becameLive: boolean } {
    everSeen.add(consumer);
    const e = live.get(consumer);
    if (e) {
        if (e.graceTimer) {
            clearTimeout(e.graceTimer);
            e.graceTimer = undefined;
        }
        e.count++;
        if (source === "ui") e.source = "ui";
        return { becameLive: false };
    }
    live.set(consumer, { count: 1, source });
    emit(consumer, true, source);
    return { becameLive: true };
}

/** Deregister an SSE connection. The STOP broadcast fires from the grace timer,
 *  not here, so a reconnect within the grace window cancels it (no flap). */
export function presenceDisconnect(consumer: string): void {
    const e = live.get(consumer);
    if (!e) return;
    e.count = Math.max(0, e.count - 1);
    if (e.count > 0 || e.graceTimer) return;
    e.graceTimer = setTimeout(() => {
        live.delete(consumer);
        emit(consumer, false);
    }, graceMs());
    // Don't keep the event loop alive just for a presence grace timer.
    e.graceTimer.unref?.();
}

/** True while a consumer holds (or is within the grace of) a live SSE. */
export function isPresent(consumer: string): boolean {
    return live.has(consumer);
}

export function presenceSource(consumer: string): LaunchSource | undefined {
    return live.get(consumer)?.source;
}

/**
 * Presence verdict for the `running` derivation:
 *   - `true`  → present (live or in grace).
 *   - `false` → seen this session but now gone (authoritative STOP, overrides a
 *               still-fresh heartbeat — the whole point of #395).
 *   - `null`  → never seen via SSE this session → caller falls back to heartbeat.
 */
export function presenceRunning(consumer: string): boolean | null {
    if (live.has(consumer)) return true;
    if (everSeen.has(consumer)) return false;
    return null;
}

/** Test-only: wipe state between cases. */
export function __resetPresence(): void {
    for (const e of live.values()) if (e.graceTimer) clearTimeout(e.graceTimer);
    live.clear();
    everSeen.clear();
}
