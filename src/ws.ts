import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

let wss: WebSocketServer | null = null;

export type WsEvent =
    | { type: "message_created"; data: unknown }
    | { type: "message_decided"; data: unknown }
    | { type: "message_edited"; data: unknown }
    | { type: "message_noted"; data: unknown }
    | { type: "message_tagged"; data: unknown }
    | { type: "rule_changed"; data: unknown }
    | { type: "tag_changed"; data: unknown }
    | { type: "strategy_changed"; data: unknown }
    | { type: "project_deleted"; data: unknown }
    | { type: "project_purged"; data: unknown }
    | { type: "consumer_changed"; data: unknown };

export function attachWs(server: Server, path = "/ws"): void {
    wss = new WebSocketServer({ server, path });
    wss.on("connection", (socket) => {
        socket.send(JSON.stringify({ type: "hello", data: { ts: Date.now() } }));
        // #B.191: per-socket liveness tracking. Reset by the pong
        // handler below; flipped to false by the keepalive sweep
        // every PING_INTERVAL_MS — peers that don't pong before the
        // next sweep are terminated so the broadcast loop doesn't
        // leak send()s into a half-dead TCP connection.
        const s = socket as WebSocket & { _aiball_alive?: boolean };
        s._aiball_alive = true;
        s.on("pong", () => { s._aiball_alive = true; });
    });
    // #B.191: send a low-level WebSocket ping every 25s. Idle TCP
    // sockets get killed by middleboxes (mobile carriers, Tailscale
    // serve, corporate proxies) after ~30-60s with no traffic. The
    // ping keeps the connection alive AND lets the server notice
    // half-dead clients (peers that didn't reply → terminate next
    // pass). The frontend's visibilitychange handler also catches
    // the case where the socket dies silently after a mobile freeze.
    const PING_INTERVAL_MS = 25_000;
    const interval = setInterval(() => {
        if (!wss) return;
        for (const client of wss.clients) {
            const c = client as WebSocket & { _aiball_alive?: boolean };
            if (c._aiball_alive === false) {
                try { c.terminate(); } catch { /* noop */ }
                continue;
            }
            c._aiball_alive = false;
            try {
                c.ping();
            } catch {
                /* noop — terminate on next pass */
            }
        }
    }, PING_INTERVAL_MS);
    wss.on("close", () => { clearInterval(interval); });
}

export function broadcast(event: WsEvent): void {
    if (!wss) return;
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
