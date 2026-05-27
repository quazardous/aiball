/**
 * #505 — canal inverse WS pour les cross-host ops (proxy node ↔ upstream).
 *
 * Phase 1 (ce fichier) : juste l'INFRA — le proxy node ouvre une WS persistante
 * vers `papy` au boot, papy l'accepte sur `/ws/proxy-node` après auth via le
 * node token, et la WS sert à la fois de **canal d'ordres** (phase 2 = pane
 * stream/keys routés ici) et de **heartbeat liveness** (chaque frame reçue
 * bumpe `tokens.last_used_at`, ce qui alimente la pastille up/down côté UI sans
 * endpoint HTTP dédié — david `medh7z` : "ok pour A. et du coup ça simplifie le
 * heartbeat").
 *
 * La WS est SEPARÉE du `/ws` browser-live-update existant (`src/ws.ts`) :
 *  - `/ws` reste le canal upstream→browser pour les events de mutation DB.
 *  - `/ws/proxy-node` est le canal upstream↔node, auth-gated, bidirectionnel.
 *
 * Authentification : `Authorization: Bearer <node-token>` à l'upgrade HTTP. Le
 * node-side client (Node.js `ws` lib) peut envoyer des headers librement. Une
 * connexion refusée (token absent/invalide/non-node) reçoit un 401 avant
 * upgrade. La connexion accepted est indexée par `node_id` (hash stable du
 * token, cf. `src/db/nodes.ts::nodeId`) pour que les futurs requests
 * `/api/agents/<id>/pane/*` puissent retrouver le bon node.
 *
 * Phase 2 (à venir) ajoutera l'envelope d'ordres (`kind`, `request_id`) et le
 * routing depuis `agents.ts`.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { getToken } from "./db/tokens.js";
import { nodeId as computeNodeId } from "./db/nodes.js";
import { setTokenLastSeenIp } from "./db/tokens.js";
import { nowIso } from "./db/connection.js";
import { getDb } from "./db/connection.js";
import * as schema from "./schema.js";
import { eq } from "drizzle-orm";

/** Path WS dédié au canal node↔upstream (distinct du `/ws` browser). */
export const PROXY_WS_PATH = "/ws/proxy-node";

interface ProxyNodeConn {
    node_id: string;
    token: string;
    socket: WebSocket;
    /** ms timestamp de la dernière frame reçue — sert au keepalive. */
    last_frame_ms: number;
}

const nodes = new Map<string, ProxyNodeConn>();

/** Lookup du WS d'un node par son id — utilisé par phase 2 pour router les
 *  requêtes pane vers le bon proxy. Null si le node n'est pas connecté. */
export function getProxyNodeSocket(nodeId: string): WebSocket | null {
    const c = nodes.get(nodeId);
    return c && c.socket.readyState === WebSocket.OPEN ? c.socket : null;
}

/** Snapshot des nodes connectés (pour /api/nodes ou debug). */
export function listConnectedNodeIds(): string[] {
    return [...nodes.keys()].filter((id) => {
        const c = nodes.get(id);
        return c && c.socket.readyState === WebSocket.OPEN;
    });
}

function readBearer(req: IncomingMessage): string | null {
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        if (m) return m[1].trim();
    }
    // Fallback query string (au cas où — un client browser-style ne pourrait
    // pas set le header). Pas utilisé côté node Node.js, mais utile pour debug
    // avec `wscat` sans bricoler les headers.
    const url = new URL(req.url ?? "/", "http://localhost");
    const qt = url.searchParams.get("token");
    if (qt) return qt;
    return null;
}

function peerIp(req: IncomingMessage): string | null {
    return req.socket?.remoteAddress ?? null;
}

/** Bumpe `tokens.last_used_at` pour ce token. Inline pour éviter un round-trip
 *  par `getTokenAndTouch` (qui re-lit la row + check l'expiration à chaque
 *  frame — overkill pour le keepalive). */
function bumpLastUsed(token: string): void {
    try {
        getDb().update(schema.tokens)
            .set({ lastUsedAt: nowIso() })
            .where(eq(schema.tokens.token, token))
            .run();
    } catch {
        /* best-effort, ne tue pas la connexion */
    }
}

export function attachProxyWs(server: Server): void {
    // `noServer: true` + handleUpgrade manuel : ça nous laisse refuser
    // proprement l'upgrade quand l'auth échoue (sinon `ws` accepte tout et on
    // doit close après — l'auth en pre-upgrade est plus propre).
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== PROXY_WS_PATH) return; // pas pour nous, laisse ws.ts gérer
        const token = readBearer(req);
        if (!token) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
            socket.destroy();
            return;
        }
        const row = getToken(token);
        if (!row || row.kind !== "node") {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }
        const nid = computeNodeId(token);
        const ip = peerIp(req);
        setTokenLastSeenIp(token, ip);
        bumpLastUsed(token);
        wss.handleUpgrade(req, socket, head, (ws) => {
            // Si un autre WS du même node était déjà ouvert (reconnect rapide),
            // on close le précédent — un node = une connexion active.
            const prev = nodes.get(nid);
            if (prev) {
                try { prev.socket.close(1000, "superseded"); } catch { /* noop */ }
            }
            const conn: ProxyNodeConn = {
                node_id: nid,
                token,
                socket: ws,
                last_frame_ms: Date.now(),
            };
            nodes.set(nid, conn);
            ws.send(JSON.stringify({ kind: "hello", node_id: nid, server_ts: Date.now() }));
            // Bump last_used_at + last_frame_ms sur chaque message (phase 2
            // viendra parser le `kind` pour router vers les handlers d'ordre).
            ws.on("message", () => {
                conn.last_frame_ms = Date.now();
                bumpLastUsed(token);
            });
            ws.on("pong", () => {
                conn.last_frame_ms = Date.now();
                bumpLastUsed(token);
            });
            ws.on("close", () => {
                // N'enlève la map QUE si on est encore le conn courant (sinon
                // un supersede a déjà installé le nouveau).
                if (nodes.get(nid) === conn) nodes.delete(nid);
            });
            ws.on("error", () => {
                try { ws.terminate(); } catch { /* noop */ }
            });
        });
    });

    // Keepalive : ping toutes les 25s, terminate les conns non-pong (#B.191 same
    // pattern que `src/ws.ts`). Les middleboxes (NAT, load balancers) coupent
    // les TCP idle ~30-60s, ce ping garde la conn warm.
    const PING_INTERVAL_MS = 25_000;
    const STALE_MS = 60_000;
    const interval = setInterval(() => {
        const now = Date.now();
        for (const [nid, conn] of nodes) {
            if (conn.socket.readyState !== WebSocket.OPEN) {
                nodes.delete(nid);
                continue;
            }
            if (now - conn.last_frame_ms > STALE_MS) {
                try { conn.socket.terminate(); } catch { /* noop */ }
                nodes.delete(nid);
                continue;
            }
            try { conn.socket.ping(); } catch { /* noop */ }
        }
    }, PING_INTERVAL_MS);
    interval.unref(); // ne pas garder le process en vie tout seul (tests)
    server.on("close", () => clearInterval(interval));
}
