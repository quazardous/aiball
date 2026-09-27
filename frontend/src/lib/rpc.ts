/**
 * #3068 — the web UI's connection to the daemon's bus (docs/API-BUS.md): one
 * WebSocket at `/bus`, JSON-RPC 2.0 over it. Not `bus.ts`, which is the page's
 * own event bus.
 *
 * Opened on the first call and kept open. A call made while the connection is
 * down waits for it: nothing was sent, so it is safe to send once it is back.
 * A call already sent when the connection drops fails (`UNAVAILABLE`): it may
 * have run, and only its caller knows whether to try again.
 *
 * A browser cannot read why a WebSocket opening was refused, so a connection
 * that never opens asks `GET /api/auth/status` whether the token still counts.
 *
 * A subscription (`bus.subscribe`) is kept across connections: after a
 * reconnect it is made again with `since`, the daemon's epoch and the last
 * `seq` this connection received, so the events missed meanwhile come first.
 * While a subscription is open the connection is kept, calls or not.
 */
import { withBase } from "./base";

/** A call the daemon refused, or could not run. */
export class RpcError extends Error {
    constructor(
        /** aiball's error code (docs/API-ERRORS.md). */
        readonly code: string,
        /** The HTTP status it matches. */
        readonly status: number,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
    }
}

interface RpcErrorBody {
    code: number;
    message: string;
    data?: { code?: string; status?: number; details?: Record<string, unknown> };
}

type Reply = { id: number; result?: unknown; error?: RpcErrorBody };

type BusEvent = { subscription: string; subject: string; seq: number; data: unknown };

interface SubscribeAnswer {
    id: string;
    seq: number;
    epoch: string;
    replayed: boolean;
    value?: unknown;
    events?: { subject: string; seq: number; data: unknown }[];
}

export interface RpcSubscribeOptions {
    /** More parameters for `bus.subscribe` (`open`, `include_postponed`…). */
    params?: Record<string, unknown>;
    /** The subject's whole value: on the first subscription, and after a gap the daemon could not replay. */
    onValue?: (value: unknown) => void;
    /** Subscribed (true), or its connection lost (false). */
    onActive?: (active: boolean) => void;
}

interface Sub {
    subject: string;
    onEvent: (data: unknown, subject: string) => void;
    opts: RpcSubscribeOptions;
    id: string | null;
    closed: boolean;
}

interface Waiting {
    method: string;
    frame: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

export interface RpcOptions {
    /** The `/bus` URL; by default the page's host, under its base path. */
    url?: () => string;
    token?: () => string | null;
    /** The token no longer counts: the page goes to its login. */
    onUnauthorized?: () => void;
    /** Whether the token counts, asked when an opening fails. */
    authValid?: () => Promise<boolean>;
    WebSocketImpl?: typeof WebSocket;
}

function defaultUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${withBase("/bus")}`;
}

async function defaultAuthValid(): Promise<boolean> {
    try {
        const tok = localStorage.getItem("aiball.token");
        const res = await fetch(withBase("/api/auth/status"), { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
        if (!res.ok) return true; // not an answer about the token
        const s = (await res.json()) as { me: unknown };
        return s.me !== null;
    } catch {
        return true; // the daemon is down: nothing to say about the token
    }
}

export class Rpc {
    private ws: WebSocket | null = null;
    private open = false;
    private nextId = 1;
    /** Sent, waiting for their answer. */
    private readonly sent = new Map<number, Waiting>();
    /** Not sent yet: the connection is not open. */
    private queue: Waiting[] = [];
    private retry = 500;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private failedOpenings = 0;
    private readonly WS: typeof WebSocket;
    private readonly subs = new Set<Sub>();
    private readonly subById = new Map<string, Sub>();
    /** The daemon's epoch and the last `seq` received: where a subscription resumes. */
    private epoch: string | null = null;
    private lastSeq = 0;

    constructor(private readonly opts: RpcOptions = {}) {
        this.WS = opts.WebSocketImpl ?? WebSocket;
    }

    /** One call: its result, or an `RpcError`. */
    call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const id = this.nextId++;
            const w: Waiting = { method, frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }), resolve: resolve as (v: unknown) => void, reject };
            if (this.open && this.ws) {
                this.sent.set(id, w);
                this.ws.send(w.frame);
            } else {
                this.queue.push(w);
                this.connect();
            }
        });
    }

    /**
     * Subscribe to a subject: `onEvent` gets each event's data, in order. The
     * subscription lives until `close()`, across reconnections.
     */
    subscribe(subject: string, onEvent: (data: unknown, subject: string) => void, opts: RpcSubscribeOptions = {}): { close(): void } {
        const s: Sub = { subject, onEvent, opts, id: null, closed: false };
        this.subs.add(s);
        if (this.open) this.start(s);
        else this.connect();
        return {
            close: () => {
                s.closed = true;
                this.subs.delete(s);
                if (s.id) {
                    this.subById.delete(s.id);
                    if (this.open) this.call("bus.unsubscribe", { id: s.id }).catch(() => {});
                }
            },
        };
    }

    /** Reconnect now if the connection is down (a tab back in view). */
    wake(): void {
        if (this.open) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.retry = 500;
        if (this.wanted()) this.connect();
    }

    /** Whether anything needs the connection: a call waiting, or a subscription. */
    private wanted(): boolean {
        return this.queue.length > 0 || this.subs.size > 0;
    }

    private start(s: Sub): void {
        const since = this.epoch !== null && this.lastSeq > 0 ? { epoch: this.epoch, seq: this.lastSeq } : undefined;
        this.call<SubscribeAnswer>("bus.subscribe", { ...(s.opts.params ?? {}), subject: s.subject, ...(since ? { since } : {}) })
            .then((r) => {
                if (s.closed) {
                    this.call("bus.unsubscribe", { id: r.id }).catch(() => {});
                    return;
                }
                s.id = r.id;
                this.subById.set(r.id, s);
                if (r.seq > this.lastSeq) this.lastSeq = r.seq;
                if (r.replayed) {
                    for (const e of r.events ?? []) s.onEvent(e.data, e.subject);
                } else {
                    s.opts.onValue?.(r.value);
                }
                s.opts.onActive?.(true);
            })
            // A connection lost meanwhile subscribes it again when it is back.
            .catch(() => {});
    }

    close(): void {
        const ws = this.ws;
        this.ws = null;
        this.open = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        ws?.close();
    }

    private connect(): void {
        if (this.ws || this.timer) return;
        const token = (this.opts.token ?? (() => localStorage.getItem("aiball.token")))();
        const base = (this.opts.url ?? defaultUrl)();
        const ws = new this.WS(token ? `${base}?token=${encodeURIComponent(token)}` : base);
        this.ws = ws;
        let hello = false;
        ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data)) as Reply | Reply[] | { method?: string };
            if (!hello) {
                // The daemon speaks first: until its hello, nothing is sent.
                const h = msg as { method?: string; params?: { epoch?: string } };
                if (h.method !== "bus.hello") return;
                hello = true;
                this.open = true;
                this.retry = 500;
                this.failedOpenings = 0;
                // A daemon restarted: nothing of the old epoch can be replayed.
                const epoch = h.params?.epoch ?? null;
                if (epoch !== this.epoch) this.lastSeq = 0;
                this.epoch = epoch;
                const queued = this.queue;
                this.queue = [];
                for (const w of queued) {
                    const id = (JSON.parse(w.frame) as { id: number }).id;
                    this.sent.set(id, w);
                    ws.send(w.frame);
                }
                for (const s of this.subs) this.start(s);
                return;
            }
            const n = msg as { method?: string; params?: BusEvent };
            if (n.method === "bus.event" && n.params) {
                const e = n.params;
                if (e.seq > this.lastSeq) this.lastSeq = e.seq;
                this.subById.get(e.subscription)?.onEvent(e.data, e.subject);
                return;
            }
            for (const r of Array.isArray(msg) ? msg : [msg as Reply]) this.settle(r);
        };
        // A browser fires `close` after every `error`; not every WebSocket does
        // (Node's fires only `error` on a refused connection). Either one ends
        // this socket, once. Closing from `error` on a socket still connecting
        // fires `error` again, so it is only let go.
        const lost = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.open = false;
            for (const w of this.sent.values()) {
                w.reject(new RpcError("UNAVAILABLE", 503, `${w.method} → the connection to the daemon closed before its answer`));
            }
            this.sent.clear();
            this.subById.clear();
            for (const s of this.subs) {
                s.id = null;
                s.opts.onActive?.(false);
            }
            if (!hello) void this.openingFailed();
            if (this.wanted()) this.scheduleRetry();
        };
        ws.onclose = lost;
        ws.onerror = lost;
    }

    private settle(r: Reply): void {
        if (typeof r.id !== "number") return;
        const w = this.sent.get(r.id);
        if (!w) return;
        this.sent.delete(r.id);
        if (r.error) {
            const status = r.error.data?.status ?? 500;
            w.reject(new RpcError(r.error.data?.code ?? "INTERNAL", status, `${w.method} → ${status}: ${r.error.message}`, r.error.data?.details));
        } else {
            w.resolve(r.result);
        }
    }

    private async openingFailed(): Promise<void> {
        this.failedOpenings++;
        // Once is a daemon restarting; twice in a row, ask about the token.
        if (this.failedOpenings < 2) return;
        if (await (this.opts.authValid ?? defaultAuthValid)()) return;
        const queued = this.queue;
        this.queue = [];
        for (const w of queued) w.reject(new RpcError("UNAUTHORIZED", 401, `${w.method} → 401: the token no longer counts`));
        this.opts.onUnauthorized?.();
    }

    private scheduleRetry(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.wanted()) this.connect();
        }, this.retry);
        this.retry = Math.min(this.retry * 2, 10_000);
    }
}
