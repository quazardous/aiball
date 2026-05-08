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
    | { type: "project_deleted"; data: unknown };

export function attachWs(server: Server, path = "/ws"): void {
    wss = new WebSocketServer({ server, path });
    wss.on("connection", (socket) => {
        socket.send(JSON.stringify({ type: "hello", data: { ts: Date.now() } }));
    });
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
