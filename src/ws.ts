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
    | { type: "automation_rule_changed"; data: unknown }
    | { type: "tag_changed"; data: unknown }
    | { type: "strategy_changed"; data: unknown }
    | { type: "project_deleted"; data: unknown }
    | { type: "project_purged"; data: unknown }
    | { type: "consumer_changed"; data: unknown };

export function attachWs(server: Server, path = "/ws"): void {
    // #505 — `{server, path}` callait `wss.handleUpgrade` UNCONDITIONNELLEMENT
    // côté ws lib, qui `abortHandshake(socket, 400)` quand le path ne matchait
    // pas → le socket est destroy pour TOUS les autres path-scoped WSS sur le
    // même server (e.g. proxy-ws.ts pour /ws/proxy-node). On passe en
    // `noServer` + manual upgrade dispatch qui ne touche pas le socket si le
    // path ne matche pas.
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== path) return;
        wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit("connection", ws, req);
        });
    });
    wss.on("connection", (socket) => {
        socket.send(JSON.stringify({ type: "hello", data: { ts: Date.now() } }));
        // Liveness flag flipped false each keepalive sweep, reset by pong (#B.191).
        const s = socket as WebSocket & { _aiball_alive?: boolean };
        s._aiball_alive = true;
        s.on("pong", () => { s._aiball_alive = true; });
    });
    // Middleboxes kill idle TCP at 30-60s; ping keeps it warm and
    // surfaces half-dead clients server-side (#B.191).
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
