/**
 * #3063 — the bus: one WebSocket per client, JSON-RPC 2.0 on it. The caller is
 * authenticated once, on the request that opens the connection, by the same
 * `authenticate` HTTP uses; every call on the connection runs as that caller,
 * straight into the method table. A revoked token closes its connections.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { authenticate, bearerFrom, type AuthOutcome } from "../auth.js";
import { getToken, getTokenAndTouch, onTokenRevoked } from "../db/tokens.js";
import { touchLastSeen } from "../db/consumers.js";
import { BUS_PATH, BUS_VERSION } from "../bus-protocol.js";
import { callerOf, type Caller } from "./methods.js";
import { handleFrame } from "./rpc.js";
import "./register.js";

/** A frame larger than this closes the connection (1009). */
export const BUS_MAX_FRAME = 4 * 1024 * 1024;

/** A client this far behind on reading is cut, not buffered without end. */
export const BUS_MAX_BUFFERED = 8 * 1024 * 1024;

/** Keepalive, and the check of a token revoked elsewhere. */
export const BUS_SWEEP_MS = 25_000;

/** Close codes a client can tell apart. */
export const BUS_CLOSE = {
    /** The token the connection rests on was revoked or expired. */
    TOKEN_REVOKED: 4001,
    /** The client did not read what it was sent. */
    TOO_SLOW: 4002,
} as const;

interface Conn {
    ws: WebSocket;
    caller: Caller;
    /** Frames run one after another: an answer never overtakes an earlier one. */
    queue: Promise<void>;
    /** Set by a call since the last sweep: the sweep then refreshes last-seen. */
    active: boolean;
    /** Whether calls refresh last-seen: as on HTTP, not for an anonymous local caller. */
    seen: boolean;
    alive: boolean;
}

const conns = new Set<Conn>();

onTokenRevoked((token) => {
    for (const c of conns) {
        if (c.caller.token === token) c.ws.close(BUS_CLOSE.TOKEN_REVOKED, "token revoked");
    }
});

function refuseUpgrade(socket: Duplex, out: Extract<AuthOutcome, { ok: false }>): void {
    const body = JSON.stringify({ error: out.error, code: out.code, ...(out.hint ? { hint: out.hint } : {}) });
    const reason = out.status === 401 ? "Unauthorized" : "Forbidden";
    socket.write(
        `HTTP/1.1 ${out.status} ${reason}\r\n` +
        (out.status === 401 ? "WWW-Authenticate: Bearer\r\n" : "") +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
}

/** Authenticate the opening request, as HTTP would authenticate a request. */
export function authenticateUpgrade(req: IncomingMessage, trusted: boolean): AuthOutcome {
    const header = (name: string) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    return authenticate({
        transport: trusted ? "uds" : "tcp",
        header,
        token: trusted ? null : bearerFrom(header, query),
        ip: trusted ? null : req.socket?.remoteAddress ?? null,
    });
}

/**
 * Serve the bus on `server`. `trusted` is the local socket: same-user trust,
 * the identity from `x-aiball-consumer`, as for `/api` there.
 */
export function attachBus(server: Server, opts: { trusted?: boolean } = {}): WebSocketServer {
    const trusted = opts.trusted === true;
    const wss = new WebSocketServer({ noServer: true, maxPayload: BUS_MAX_FRAME });
    server.on("upgrade", (req, socket, head) => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== BUS_PATH) return;
        const out = authenticateUpgrade(req, trusted);
        if (!out.ok) {
            refuseUpgrade(socket, out);
            return;
        }
        const caller = callerOf(out.ctx);
        const named = typeof req.headers["x-aiball-consumer"] === "string" && req.headers["x-aiball-consumer"].trim() !== "";
        wss.handleUpgrade(req, socket, head, (ws) => open(ws, caller, !trusted || named));
    });

    const sweep = setInterval(() => sweepConnections(wss), BUS_SWEEP_MS);
    sweep.unref?.();
    wss.on("close", () => clearInterval(sweep));
    return wss;
}

/**
 * One pass over `wss`'s connections: a client that did not answer the last
 * ping is cut; a token deleted by another process (the CLI) or expired closes
 * its connection; a connection used since the last pass refreshes last-seen,
 * once per pass rather than on every call.
 */
export function sweepConnections(wss: WebSocketServer): void {
    for (const c of conns) {
        if (!wss.clients.has(c.ws)) continue;
        if (!c.alive) {
            c.ws.terminate();
            continue;
        }
        c.alive = false;
        try { c.ws.ping(); } catch { /* cut on the next pass */ }
        if (c.caller.token) {
            const row = c.active ? getTokenAndTouch(c.caller.token) : getToken(c.caller.token);
            if (!row) {
                c.ws.close(BUS_CLOSE.TOKEN_REVOKED, "token revoked");
                continue;
            }
        }
        if (c.active && c.seen && c.caller.consumer_id) {
            touchLastSeen(c.caller.consumer_id, c.caller.token_kind === "node" ? "node" : c.caller.transport);
        }
        c.active = false;
    }
}

function open(ws: WebSocket, caller: Caller, seen: boolean): void {
    const c: Conn = { ws, caller, queue: Promise.resolve(), active: false, seen, alive: true };
    conns.add(c);
    ws.on("pong", () => { c.alive = true; });
    ws.on("close", () => { conns.delete(c); });
    ws.on("message", (data, isBinary) => {
        if (isBinary) {
            ws.close(1003, "text frames only");
            return;
        }
        c.alive = true;
        c.active = true;
        const text = data.toString();
        c.queue = c.queue.then(async () => {
            const out = await handleFrame(caller, text);
            if (out === null || ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > BUS_MAX_BUFFERED) {
                ws.close(BUS_CLOSE.TOO_SLOW, "too slow");
                return;
            }
            ws.send(out);
        });
    });
    ws.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "bus.hello",
        params: { version: BUS_VERSION, consumer: caller.consumer_id ?? null, kind: caller.kind, relayed: caller.relayed },
    }));
}

/** Test hook: the connections open now. */
export function busConnectionCountForTests(): number {
    return conns.size;
}
