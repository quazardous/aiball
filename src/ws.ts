import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { resolveTokenToConsumer } from "./auth.js";

const servers = new Set<WebSocketServer>();

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
    | { type: "project_renamed"; data: unknown }
    | { type: "project_purged"; data: unknown }
    | { type: "consumer_changed"; data: unknown }
    // #3030 — an agent's loop bar changed, or went stale (its loop stopped).
    | { type: "agent_bar"; data: unknown };

/**
 * #3000 — who may open `/ws`. On the local socket, the same trust as `/api`
 * there: same user, no token. On TCP (the web UI, Tailscale) a valid token is
 * required, like `/api`: `Authorization: Bearer`, `x-aiball-token`, or
 * `?token=` (a browser cannot set headers on a WebSocket). Before this, any
 * tailnet peer could read the whole ticket feed without logging in.
 */
export function wsUpgradeAllowed(req: IncomingMessage, trusted: boolean): boolean {
    if (trusted) return true;
    const auth = req.headers.authorization;
    let token = typeof auth === "string" && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
    const alt = req.headers["x-aiball-token"];
    if (!token && typeof alt === "string") token = alt.trim();
    if (!token) token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token")?.trim() ?? "";
    return !!token && resolveTokenToConsumer(token) !== null;
}

/**
 * #3000 — a client that does not keep up is cut rather than buffered without
 * end: past this many bytes waiting in its socket, it is terminated, and the
 * clients reconnect on their own.
 */
export const WS_MAX_BUFFERED = 8 * 1024 * 1024;

export function attachWs(server: Server, path = "/ws", opts: { trusted?: boolean } = {}): void {
    // #505 — `{server, path}` callait `wss.handleUpgrade` UNCONDITIONNELLEMENT
    // côté ws lib, qui `abortHandshake(socket, 400)` quand le path ne matchait
    // pas → le socket est destroy pour TOUS les autres path-scoped WSS sur le
    // même server (e.g. proxy-ws.ts pour /ws/proxy-node). On passe en
    // `noServer` + manual upgrade dispatch qui ne touche pas le socket si le
    // path ne matche pas.
    // #3000 — one server per listener (TCP, and the local socket); `broadcast`
    // reaches the clients of all of them.
    const wss = new WebSocketServer({ noServer: true });
    servers.add(wss);
    const trusted = opts.trusted === true;
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== path) return;
        if (!wsUpgradeAllowed(req, trusted)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
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
    // Don't let the keepalive ping be the sole thing keeping the event loop
    // alive — the listening HTTP server already holds the daemon open in
    // prod ; without unref a headless test that calls attachWs() never exits.
    interval.unref?.();
    wss.on("close", () => { clearInterval(interval); servers.delete(wss); });
}

export function broadcast(event: WsEvent): void {
    if (servers.size === 0) return;
    const payload = JSON.stringify(event);
    for (const wss of servers) {
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            // #3000 — backpressure: a client this far behind is cut, not fed.
            if (client.bufferedAmount > WS_MAX_BUFFERED) {
                try { client.terminate(); } catch { /* noop */ }
                continue;
            }
            client.send(payload);
        }
    }
}

/** Test hook: the servers `broadcast` reaches, to reach a client's server side. */
export function wsServersForTests(): ReadonlySet<WebSocketServer> {
    return servers;
}
