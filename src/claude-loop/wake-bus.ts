/**
 * #628 david `mquuep` — WakeBus : façade typed sur le canal SSE
 * daemon→loop. Un seul subscribe physique sur `subscribeEvents` ; les
 * consumers locaux (timer, hooks, MCP, fake-claude tests) écoutent via
 * `bus.on(event, cb)` sans re-créer un EventSource.
 *
 * Surface volontairement narrow : on n'expose que les events VRAIMENT
 * "métier ticket/message" (ping, control, hello, error). Le wake gating
 * + le coalesce restent sur le consumer (le timer décide via tryWake).
 *
 * Reconnect : géré en interne avec throttle (1/5s). Sur SSE drop, le
 * bus tente une reconnexion à la prochaine `kick()` du caller (typiquement
 * le heartbeat) — pas de timer interne pour ne pas dupliquer la
 * cadence du timer existant.
 */
import type { AiballClient } from "../client.js";

/** Wake hint from a `sse:ping` event — the SSE payload as-is. */
export interface PingHint {
    ticket_id?: number;
    comment_id?: number;
    comment_hashid?: string;
    intent?: "panic" | "request" | "question" | "fyi";
}

/** Subset of control events the WakeBus surfaces. */
export type ControlEvent =
    | { action: "kill" }
    | { action: "prompt"; text: string }
    | { action: string; [k: string]: unknown };

/** Hello envelope sent by the daemon on first connect. */
export interface HelloEvent {
    consumer_id: string;
    unread: number;
}

/** Type-of-event → callback signature mapping. Mirror of the bus.on map. */
export interface WakeBusEvents {
    ping: (hint: PingHint) => void;
    control: (event: ControlEvent) => void;
    hello: (event: HelloEvent) => void;
    error: (err: Error) => void;
}

export type Unsubscribe = () => void;

export class WakeBus {
    private pingListeners: WakeBusEvents["ping"][] = [];
    private controlListeners: WakeBusEvents["control"][] = [];
    private helloListeners: WakeBusEvents["hello"][] = [];
    private errorListeners: WakeBusEvents["error"][] = [];
    private clientUnsubscribe: (() => void) | null = null;
    private lastConnectAt = 0;
    private throttleMs: number;
    /** Default 5s reconnect throttle — same as the legacy inline reconnect. */
    private static DEFAULT_THROTTLE_MS = 5000;

    constructor(
        private readonly client: AiballClient,
        opts: { throttleMs?: number } = {},
    ) {
        this.throttleMs = opts.throttleMs ?? WakeBus.DEFAULT_THROTTLE_MS;
    }

    /** Subscribe to a typed event. Returns an unsubscribe handle. */
    on<K extends keyof WakeBusEvents>(event: K, cb: WakeBusEvents[K]): Unsubscribe {
        const arr = this.listFor(event);
        arr.push(cb);
        return () => {
            const i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
        };
    }

    /** Connect to the daemon SSE channel. Idempotent : throttles a hot
     *  loop. Throws nothing — errors flow through the `error` event. */
    connect(): void {
        // Throttle so a daemon flap doesn't turn into a hot loop.
        const now = Date.now();
        if (now - this.lastConnectAt < this.throttleMs) return;
        this.lastConnectAt = now;
        this.clientUnsubscribe?.();
        this.clientUnsubscribe = this.client.subscribeEvents({
            onPing: (p) => this.emitPing(p as PingHint),
            onHello: (h) => this.emitHello(h),
            onControl: (c) => this.emitControl(c as ControlEvent),
            onError: (e) => {
                this.emitError(e);
                this.clientUnsubscribe = null;
            },
        });
    }

    /** True iff the SSE subscription is currently held. The timer's
     *  heartbeat reads this to decide if it needs to `connect()` again. */
    isConnected(): boolean {
        return this.clientUnsubscribe !== null;
    }

    /** Drop the SSE subscription + reset state. The caller is expected to
     *  call this at clean shutdown — re-`connect()` re-opens fresh. */
    close(): void {
        try { this.clientUnsubscribe?.(); } catch { /* ignore */ }
        this.clientUnsubscribe = null;
        this.pingListeners.length = 0;
        this.controlListeners.length = 0;
        this.helloListeners.length = 0;
        this.errorListeners.length = 0;
    }

    private listFor<K extends keyof WakeBusEvents>(event: K): WakeBusEvents[K][] {
        switch (event) {
            case "ping":    return this.pingListeners as WakeBusEvents[K][];
            case "control": return this.controlListeners as WakeBusEvents[K][];
            case "hello":   return this.helloListeners as WakeBusEvents[K][];
            case "error":   return this.errorListeners as WakeBusEvents[K][];
            default:        throw new Error(`WakeBus: unknown event '${String(event)}'`);
        }
    }

    private emitPing(hint: PingHint): void {
        for (const cb of [...this.pingListeners]) {
            try { cb(hint); } catch { /* swallow */ }
        }
    }
    private emitControl(event: ControlEvent): void {
        for (const cb of [...this.controlListeners]) {
            try { cb(event); } catch { /* swallow */ }
        }
    }
    private emitHello(event: HelloEvent): void {
        for (const cb of [...this.helloListeners]) {
            try { cb(event); } catch { /* swallow */ }
        }
    }
    private emitError(err: Error): void {
        for (const cb of [...this.errorListeners]) {
            try { cb(err); } catch { /* swallow */ }
        }
    }
}
