/**
 * #3063 — a client of the bus, for aiball's own clients (claude-loop, the MCP
 * server, the CLI) and the tests: one connection, calls and batches over it.
 * Loads nothing of the core. See docs/API-BUS.md.
 */
import { WebSocket } from "ws";
import { BUS_PATH, type RpcErrorData, type RpcResponse } from "./bus-protocol.js";

/** A call the daemon refused, or could not run. */
export class BusError extends Error {
    constructor(
        /** aiball's error code (docs/API-ERRORS.md). */
        readonly code: string,
        /** The HTTP status it matches. */
        readonly status: number,
        message: string,
        /** JSON-RPC's own code: the status for a refusal, -32xxx for a protocol error. */
        readonly rpcCode: number,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
    }
}

export interface BusConnectOptions {
    /** The daemon's local socket: same-user trust, no token. */
    socket?: string;
    /** Over TCP: the daemon's base URL, `http://host:port`. */
    url?: string;
    token?: string;
    /** Who this client is on the local socket (`x-aiball-consumer`). */
    consumer?: string;
    headers?: Record<string, string>;
}

export interface BusHello {
    version: number;
    /** Changes when the daemon restarts: a subscription's `since` needs it. */
    epoch: string;
    consumer: string | null;
    /** human, agent or key. */
    kind: string;
    /** Relayed by a proxy node. */
    relayed: boolean;
}

type Settled = { ok: true; result: unknown } | { ok: false; error: BusError };

function toError(e: { code: number; message: string; data?: RpcErrorData }): BusError {
    return new BusError(e.data?.code ?? "INTERNAL", e.data?.status ?? 500, e.message, e.code, e.data?.details);
}

export class BusClient {
    private nextId = 1;
    private readonly pending = new Map<number, (r: RpcResponse) => void>();

    private constructor(private readonly ws: WebSocket, readonly hello: BusHello) {
        ws.on("message", (data) => this.receive(data.toString()));
        ws.on("close", (code, reason) => {
            const err = new BusError("UNAVAILABLE", 503, `bus closed (${code}${reason.length ? ` ${reason}` : ""})`, code);
            for (const resolve of this.pending.values()) {
                resolve({ jsonrpc: "2.0", id: null, error: { code, message: err.message, data: { code: "UNAVAILABLE", status: 503 } } });
            }
            this.pending.clear();
        });
    }

    /** Open a connection; resolves once the daemon said hello. */
    static connect(opts: BusConnectOptions): Promise<BusClient> {
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        if (opts.consumer) headers["x-aiball-consumer"] = opts.consumer;
        const target = opts.socket
            ? `ws+unix:${opts.socket}:${BUS_PATH}`
            : `${(opts.url ?? "").replace(/^http/, "ws").replace(/\/$/, "")}${BUS_PATH}`;
        const ws = new WebSocket(target, { headers });
        return new Promise((resolve, reject) => {
            const failOpen = (e: Error) => reject(e);
            ws.once("error", failOpen);
            ws.once("unexpected-response", (_req, res) => {
                let body = "";
                res.on("data", (d: Buffer) => { body += d.toString(); });
                res.on("end", () => {
                    let parsed: { error?: string; code?: string } = {};
                    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
                    reject(new BusError(parsed.code ?? "UNAUTHORIZED", res.statusCode ?? 401, parsed.error ?? `bus refused (${res.statusCode})`, res.statusCode ?? 401));
                });
            });
            ws.once("message", (data) => {
                ws.off("error", failOpen);
                const m = JSON.parse(data.toString()) as { method?: string; params?: BusHello };
                if (m.method !== "bus.hello" || !m.params) {
                    ws.close();
                    reject(new Error("the bus did not say hello"));
                    return;
                }
                resolve(new BusClient(ws, m.params));
            });
        });
    }

    private receive(text: string): void {
        const msg = JSON.parse(text) as RpcResponse | RpcResponse[];
        for (const r of Array.isArray(msg) ? msg : [msg]) {
            if (typeof r.id !== "number") continue;
            const resolve = this.pending.get(r.id);
            if (!resolve) continue;
            this.pending.delete(r.id);
            resolve(r);
        }
    }

    private request(method: string, params: unknown): { frame: object; done: Promise<RpcResponse> } {
        const id = this.nextId++;
        if (this.ws.readyState !== WebSocket.OPEN) {
            // Nothing would ever answer: settle at once, as a closed connection does.
            const error = { code: 1006, message: "bus closed", data: { code: "UNAVAILABLE", status: 503 } };
            return { frame: {}, done: Promise.resolve({ jsonrpc: "2.0", id, error }) };
        }
        const done = new Promise<RpcResponse>((resolve) => this.pending.set(id, resolve));
        return { frame: { jsonrpc: "2.0", id, method, params }, done };
    }

    /** One call: its result, or a `BusError`. */
    async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
        const { frame, done } = this.request(method, params);
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
        const r = await done;
        if ("error" in r) throw toError(r.error);
        return r.result as T;
    }

    /** Several calls in one frame, run in order; each settles on its own. */
    async batch(calls: { method: string; params?: unknown }[]): Promise<Settled[]> {
        const reqs = calls.map((c) => this.request(c.method, c.params ?? {}));
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(reqs.map((r) => r.frame)));
        const rs = await Promise.all(reqs.map((r) => r.done));
        return rs.map((r) => ("error" in r ? { ok: false, error: toError(r.error) } : { ok: true, result: r.result }));
    }

    /** Resolves when the daemon closed the connection, with its close code. */
    closed(): Promise<number> {
        if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
        return new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
    }

    close(): void {
        this.ws.close();
    }
}
