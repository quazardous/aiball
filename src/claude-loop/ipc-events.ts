/**
 * #729 — IPC events layer. Intent-level wrapper over a swappable transport
 * (currently `ws` over UDS, decided on #728). Public API hides the technique :
 * consumers reason in terms of `Event {kind, data}` exchanges, not raw frames.
 *
 * Three callsites :
 * - `listenEvents(path, onEvent)` : server side. Accepts connections, parses
 *   one JSON `Event` per frame, dispatches via `onEvent`. Optional `reply()`
 *   passed back to the handler so the server can respond synchronously.
 * - `openEventChannel(path)` : long-lived bidirectional client. Sends and
 *   receives `Event`s ; auto-reconnects with backoff on socket drop.
 * - `sendEventOnce(path, ev)` : short-lived single-shot client. Connects,
 *   sends one event, optionally awaits a reply, closes. For hooks (short-
 *   lived processes that fire one message and exit).
 *
 * Transport (today) : `ws` 8.x over a Unix Domain Socket. The server binds
 * `http.createServer().listen({path})` and attaches `WebSocketServer`. The
 * client connects via `ws+unix://path` — `ws` supports this URI scheme
 * natively for UDS targets. If we ever swap (zmq, grpc, etc.), the API
 * here stays identical ; only this file changes.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { WebSocketServer, WebSocket, type RawData } from "ws";

/** Event shape exchanged on every IPC channel. `kind` is the discriminator
 *  the consumer dispatches on ; `data` is the per-kind payload (free-form
 *  JSON-serializable). Reply frames have the same shape. */
export interface Event {
    kind: string;
    data?: unknown;
}

/** Server handle returned by `listenEvents`. Call `close()` on shutdown to
 *  unlink the socket file and stop accepting connections. Idempotent. */
export interface EventServer {
    close(): void;
    /** Push an event to every currently-connected client. Best-effort :
     *  sends on each open WebSocket and swallows per-client failures
     *  (a dead client doesn't block delivery to live ones). No-op if no
     *  client is connected — the event is dropped (caller doesn't need
     *  to track connection state). */
    broadcast(ev: Event): void;
    /** Count of currently-open client connections. Useful for tests +
     *  diagnostics (\"is the proxy actually connected ?\"). */
    clientCount(): number;
}

/** Per-event reply hook handed to the server handler. Send a single
 *  response back to the originating client. Calling it more than once
 *  is a no-op (subsequent calls dropped silently). */
export type EventReply = (response?: Event) => void;

/** Server handler shape. The optional `ctx.reply` lets the handler emit a
 *  synchronous response for request/response patterns. */
export type EventHandler = (ev: Event, ctx: { reply: EventReply }) => void;

/** Long-lived bidirectional client handle returned by `openEventChannel`. */
export interface EventChannel {
    /** Fire-and-forget send. Drops silently if not currently connected
     *  (the reconnect loop is best-effort ; callers shouldn't assume
     *  ordering across disconnects). */
    send(ev: Event): void;
    /** Send + wait for a single reply frame. Rejects on timeout or
     *  disconnect mid-flight. */
    request(ev: Event, timeoutMs?: number): Promise<Event>;
    /** Subscribe to inbound events (server pushes). Replaces any prior
     *  handler. Pass null to clear. */
    onEvent(handler: ((ev: Event) => void) | null): void;
    /** True if the underlying socket is currently open. */
    isConnected(): boolean;
    /** Close the connection and stop reconnecting. Idempotent. */
    close(): void;
}

const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_ONCE_TIMEOUT_MS = 2_000;

/** Encode a UDS path as a `ws+unix://` URL the `ws` client accepts. */
function udsUrl(socketPath: string): string {
    // `ws+unix:` scheme : the socket path follows, terminated by a colon
    // and the http path. `ws` parses this and uses the socket path for
    // the underlying connect, the http path for the HTTP upgrade request.
    return `ws+unix://${socketPath}:/`;
}

/**
 * Start listening for events on the given UDS path. Returns immediately ;
 * `close()` shuts down + unlinks the socket file. Best-effort : any
 * malformed frame is silently dropped (no crash propagates to the caller).
 */
export function listenEvents(socketPath: string, onEvent: EventHandler): EventServer {
    // Cleanup orphan socket file from a previous run. Race-safe : if
    // unlink fails because the file vanished between exists & unlink,
    // we ignore — `listen()` below will surface a real bind error.
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* race */ }

    const http: HttpServer = createHttpServer();
    const wss = new WebSocketServer({ server: http });

    wss.on("connection", (ws) => {
        ws.on("message", (raw: RawData) => {
            const text = raw.toString();
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { return; /* drop malformed */ }
            if (!parsed || typeof parsed !== "object" || typeof (parsed as Event).kind !== "string") return;
            const ev = parsed as Event;
            let replied = false;
            const reply: EventReply = (response) => {
                if (replied) return;
                replied = true;
                if (response === undefined) return;
                try { ws.send(JSON.stringify(response)); } catch { /* socket dead, swallow */ }
            };
            try { onEvent(ev, { reply }); } catch { /* handler threw, swallow */ }
        });
        ws.on("error", () => { /* swallow socket-level errors */ });
    });

    // A bind failure surfaces as an async 'error' EVENT, not a throw — the
    // try/catch below only catches synchronous errors. Without a handler the
    // event is unhandled and crashes the whole process. This bites on win32
    // especially: `http.listen({ path })` treats a filesystem path as a
    // named-pipe name, so a `C:\…\loop.sock` path fails with EACCES and took
    // the claude-loop timer down on every start. Swallow it — the server
    // degrades to "not listening" (callers already tolerate a missing socket)
    // rather than crashing. Also covers EADDRINUSE on any platform. The error
    // re-emits on the WebSocketServer too, so guard both.
    http.on("error", () => { /* bind/listen failed — degrade, don't crash */ });
    wss.on("error", () => { /* server-level ws error — swallow */ });

    try { http.listen({ path: socketPath }); } catch { /* bind failed — caller observes via missing socket file */ }

    return {
        close() {
            try { wss.close(); } catch { /* ignore */ }
            try { http.close(); } catch { /* ignore */ }
            try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
        },
        broadcast(ev) {
            const payload = JSON.stringify(ev);
            for (const client of wss.clients) {
                if (client.readyState !== WebSocket.OPEN) continue;
                try { client.send(payload); } catch { /* dead client — skip, swallow */ }
            }
        },
        clientCount() {
            let n = 0;
            for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) n++;
            return n;
        },
    };
}

/**
 * Open a long-lived bidirectional channel to the given UDS path. The
 * returned handle reconnects automatically (best-effort, fixed backoff).
 * `send()` while disconnected drops silently ; use `request()` for
 * round-trip semantics.
 */
export function openEventChannel(socketPath: string, opts: { reconnectMs?: number } = {}): EventChannel {
    const reconnectMs = opts.reconnectMs ?? DEFAULT_RECONNECT_MS;
    let ws: WebSocket | null = null;
    let closed = false;
    let inboundHandler: ((ev: Event) => void) | null = null;
    const pendingRequests = new Map<string, { resolve: (ev: Event) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
    let nextRequestId = 0;

    function connect(): void {
        if (closed || ws) return;
        let attempted: WebSocket;
        try { attempted = new WebSocket(udsUrl(socketPath)); }
        catch { setTimeout(connect, reconnectMs); return; }
        const fresh = attempted;
        fresh.on("open", () => { ws = fresh; });
        fresh.on("message", (raw: RawData) => {
            let parsed: unknown;
            try { parsed = JSON.parse(raw.toString()); } catch { return; }
            if (!parsed || typeof parsed !== "object" || typeof (parsed as Event).kind !== "string") return;
            const ev = parsed as Event;
            // Request/reply correlation : the server's reply frame is a
            // plain Event whose `data` carries the request-id we set on
            // dispatch. If we don't recognise the id, treat as a push.
            const replyId = typeof (ev.data as { __req?: string } | null | undefined)?.__req === "string"
                ? (ev.data as { __req: string }).__req
                : null;
            if (replyId && pendingRequests.has(replyId)) {
                const p = pendingRequests.get(replyId)!;
                clearTimeout(p.timer);
                pendingRequests.delete(replyId);
                p.resolve(ev);
                return;
            }
            if (inboundHandler) {
                try { inboundHandler(ev); } catch { /* handler threw, swallow */ }
            }
        });
        const onClose = (): void => {
            if (ws === fresh) ws = null;
            // Reject any in-flight requests : their server is gone.
            for (const [, p] of pendingRequests) {
                clearTimeout(p.timer);
                try { p.reject(new Error("ipc-events: channel closed")); } catch { /* listener threw */ }
            }
            pendingRequests.clear();
            if (!closed) setTimeout(connect, reconnectMs);
        };
        fresh.on("close", onClose);
        fresh.on("error", () => { /* `close` will follow */ });
    }
    connect();

    return {
        send(ev) {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            try { ws.send(JSON.stringify(ev)); } catch { /* socket dead, swallow */ }
        },
        request(ev, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
            return new Promise<Event>((resolve, reject) => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    reject(new Error("ipc-events: channel not connected"));
                    return;
                }
                const id = `r${++nextRequestId}`;
                const stamped: Event = { kind: ev.kind, data: { ...(ev.data as object ?? {}), __req: id } };
                const timer = setTimeout(() => {
                    pendingRequests.delete(id);
                    reject(new Error(`ipc-events: request '${ev.kind}' timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                pendingRequests.set(id, { resolve, reject, timer });
                try { ws.send(JSON.stringify(stamped)); }
                catch (e) {
                    clearTimeout(timer);
                    pendingRequests.delete(id);
                    reject(e as Error);
                }
            });
        },
        onEvent(handler) {
            inboundHandler = handler;
        },
        isConnected() {
            return !!ws && ws.readyState === WebSocket.OPEN;
        },
        close() {
            closed = true;
            for (const [, p] of pendingRequests) {
                clearTimeout(p.timer);
                try { p.reject(new Error("ipc-events: channel closed by caller")); } catch { /* ignore */ }
            }
            pendingRequests.clear();
            if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
        },
    };
}

/**
 * Send a single event over a fresh connection, then close. For short-lived
 * processes (hooks) that fire one message and exit. If `awaitReply` is set,
 * resolves with the server's reply Event ; otherwise resolves once the
 * frame is queued on the socket.
 *
 * Errors (connect failure, timeout, etc.) are RESOLVED with `undefined`
 * rather than thrown : a hook firing an IPC event is best-effort. The
 * caller checks `result !== undefined` if they relied on a reply. (Pass
 * `throwOnError: true` to opt into rejection instead.)
 */
export async function sendEventOnce(
    socketPath: string,
    ev: Event,
    opts: { awaitReply?: boolean; timeoutMs?: number; throwOnError?: boolean } = {},
): Promise<Event | undefined> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_ONCE_TIMEOUT_MS;
    return new Promise<Event | undefined>((resolve, reject) => {
        let ws: WebSocket;
        let settled = false;
        const finish = (value: Event | undefined, error?: Error): void => {
            if (settled) return;
            settled = true;
            try { ws?.close(); } catch { /* ignore */ }
            if (error && opts.throwOnError) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(undefined, new Error(`ipc-events: sendEventOnce '${ev.kind}' timed out after ${timeoutMs}ms`)), timeoutMs);
        try { ws = new WebSocket(udsUrl(socketPath)); }
        catch (e) {
            clearTimeout(timer);
            finish(undefined, e as Error);
            return;
        }
        ws.on("open", () => {
            try { ws.send(JSON.stringify(ev)); }
            catch (e) { clearTimeout(timer); finish(undefined, e as Error); return; }
            if (!opts.awaitReply) {
                clearTimeout(timer);
                finish(undefined);
            }
        });
        if (opts.awaitReply) {
            ws.on("message", (raw: RawData) => {
                let parsed: unknown;
                try { parsed = JSON.parse(raw.toString()); }
                catch { clearTimeout(timer); finish(undefined, new Error("ipc-events: malformed reply")); return; }
                if (!parsed || typeof parsed !== "object" || typeof (parsed as Event).kind !== "string") {
                    clearTimeout(timer); finish(undefined, new Error("ipc-events: reply missing kind")); return;
                }
                clearTimeout(timer);
                finish(parsed as Event);
            });
        }
        ws.on("error", (e) => { clearTimeout(timer); finish(undefined, e as Error); });
        ws.on("close", () => { if (!settled) { clearTimeout(timer); finish(undefined, new Error("ipc-events: connection closed before reply")); } });
    });
}
