/**
 * #3071 — the bus on a proxy node: each local connection to `/bus` is relayed
 * to the upstream's `/bus`, one upstream connection each, opened with the same
 * identity rules as the node's `/api` relay (`relayAuthorization`). Messages
 * pass as they are, both ways; the node reads none of them. The upstream sees
 * the caller as relayed, and refuses it what nodes may not do.
 *
 * - The local connection is accepted only once the upstream one is open: the
 *   `bus.hello` a client gets is the upstream's, with its epoch.
 * - Either side closing closes the other: a client never keeps a connection
 *   whose subscriptions died upstream.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { BUS_PATH } from "../bus-protocol.js";
import { relayAuthorization, type ProxyConfig, type ProxyTokenStore } from "../proxy.js";
import { bearerFrom } from "../auth.js";

/** The request headers a relayed opening carries upstream: who, and what client. */
const FORWARDED = ["x-aiball-consumer", "x-aiball-platform", "x-aiball-client", "x-aiball-no-claim", "x-aiball-role"];

/** A close code the other side may be sent (1005/1006 are reserved: they say "none"). */
function sendable(code: number): number {
    return code === 1005 || code === 1006 || code < 1000 ? 1011 : code;
}

function refuse(socket: Duplex, status: number, body: string): void {
    socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
}

export function attachBusRelay(server: Server, cfg: ProxyConfig, store: ProxyTokenStore): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    const upstreamUrl = `${cfg.url.replace(/\/$/, "").replace(/^http/, "ws")}${BUS_PATH}`;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== BUS_PATH) return;
        const header = (name: string) => {
            const v = req.headers[name];
            return Array.isArray(v) ? v[0] : v;
        };
        const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        const bearer = bearerFrom(header, query);
        const auth = relayAuthorization(cfg, store, bearer ? `Bearer ${bearer}` : undefined);
        if (!auth.ok) {
            refuse(socket, 401, JSON.stringify({ error: auth.error, code: "AUTH_REQUIRED" }));
            return;
        }
        const headers: Record<string, string> = {};
        if (auth.authorization) headers.authorization = auth.authorization;
        if (cfg.nodeLabel) headers["x-aiball-node-label"] = cfg.nodeLabel;
        for (const h of FORWARDED) {
            const v = header(h);
            if (typeof v === "string" && v) headers[h] = v;
        }
        const up = new WebSocket(upstreamUrl, { headers });
        up.once("unexpected-response", (_r, res) => {
            let body = "";
            res.on("data", (d: Buffer) => { body += d.toString(); });
            res.on("end", () => refuse(socket, res.statusCode ?? 502, body || JSON.stringify({ error: "the upstream refused" })));
        });
        up.once("error", (e) => {
            if (up.readyState !== WebSocket.OPEN) refuse(socket, 502, JSON.stringify({ error: `proxy upstream unreachable: ${e.message}`, code: "BAD_GATEWAY" }));
        });
        up.once("open", () => {
            // Accepted in this same tick (no verifyClient: handleUpgrade calls
            // back synchronously), so the upstream's first message, its hello,
            // cannot arrive before the relay below is in place.
            wss.handleUpgrade(req, socket, head, (local) => {
                up.on("message", (data, binary) => {
                    if (local.readyState === WebSocket.OPEN) local.send(data, { binary });
                });
                local.on("message", (data, binary) => {
                    if (up.readyState === WebSocket.OPEN) up.send(data, { binary });
                });
                up.on("close", (code, reason) => {
                    if (local.readyState === WebSocket.OPEN) local.close(sendable(code), reason);
                });
                local.on("close", (code, reason) => {
                    if (up.readyState === WebSocket.OPEN) up.close(sendable(code), reason);
                });
                up.on("error", () => local.terminate());
                local.on("error", () => up.terminate());
            });
        });
    });
    return wss;
}
