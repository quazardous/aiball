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
import { randomBytes } from "node:crypto";
import { getToken } from "./db/tokens.js";
import { nodeId as computeNodeId, listNodes } from "./db/nodes.js";
import { setTokenLastSeenIp, setTokenDisplayHost } from "./db/tokens.js";
import { nowIso } from "./db/connection.js";
import { getDb } from "./db/connection.js";
import * as schema from "./schema.js";
import { eq } from "drizzle-orm";
import { AIBALL_VERSION, AIBALL_COMMIT } from "./version.js";

/** Path WS dédié au canal node↔upstream (distinct du `/ws` browser). */
export const PROXY_WS_PATH = "/ws/proxy-node";

interface ProxyNodeConn {
    node_id: string;
    token: string;
    socket: WebSocket;
    /** ms timestamp de la dernière frame reçue — sert au keepalive. */
    last_frame_ms: number;
    /** #513 — version + commit reportés par le proxy dans son frame `hello`.
     *  Permet de surfacer la version courante côté admin UI. NULL avant la
     *  première hello frame (rare : le proxy envoie hello juste après l'open). */
    node_version: string | null;
    node_commit: string | null;
}

const nodes = new Map<string, ProxyNodeConn>();

/** Lookup du WS d'un node par son id — utilisé par phase 2 pour router les
 *  requêtes pane vers le bon proxy. Null si le node n'est pas connecté. */
export function getProxyNodeSocket(nodeId: string): WebSocket | null {
    const c = nodes.get(nodeId);
    if (!c) return null;
    if (c.socket.readyState === WebSocket.OPEN) return c.socket;
    // #505 — la conn est dans la map mais pas OPEN (CLOSING/CLOSED). Loggue
    // pour identifier le décalage entre "node connected" et le moment où
    // une requête trouve le socket déjà mort, sans attendre le sweep 25s.
    const stateName = c.socket.readyState === WebSocket.CLOSING
        ? "CLOSING" : c.socket.readyState === WebSocket.CLOSED
        ? "CLOSED" : c.socket.readyState === WebSocket.CONNECTING
        ? "CONNECTING" : String(c.socket.readyState);
    console.log(`[proxy WS] lookup found node ${nodeId} in map but socket state=${stateName} (last_frame ${((Date.now() - c.last_frame_ms) / 1000).toFixed(1)}s ago)`);
    return null;
}

/**
 * #505 phase 2 — résout le node qui héberge un consumer donné, via le matching
 * IP (consumer.last_seen_ip == tokens.last_seen_ip pour kind=node), même
 * heuristique que `src/db/nodes.ts::relayedFor`. Renvoie le WS si le node est
 * actuellement connecté, sinon null. Le caller (agents.ts) doit fallback sur
 * `event:unavailable` dans ce cas (le node n'écoute pas, on ne peut pas livrer
 * la requête).
 */
export function getNodeSocketForConsumerIp(consumerIp: string | null): WebSocket | null {
    if (!consumerIp) return null;
    const node = listNodes().find((n) => n.last_seen_ip === consumerIp);
    if (!node) return null;
    return getProxyNodeSocket(node.node_id);
}

// --- envelope d'ordres : tracking par request_id -----------------------------

/** Type minimal d'une frame "envelope" : `{kind, request_id, ...}`. */
export interface PaneFrame { kind: string; request_id?: string; [k: string]: unknown }

type ResponseHandler = (frame: PaneFrame) => void;
/** Par request_id → handler. Le handler est appelé pour CHAQUE frame avec ce
 *  request_id (un stream émet plusieurs `pane.frame`). C'est le caller qui
 *  unregister via `unregisterResponseHandler` quand son écoute s'arrête. */
const responseHandlers = new Map<string, ResponseHandler>();

/** Génère un request_id court mais unique enough pour borner les collisions. */
export function newRequestId(): string {
    return randomBytes(8).toString("hex");
}

export function registerResponseHandler(requestId: string, handler: ResponseHandler): void {
    responseHandlers.set(requestId, handler);
}

export function unregisterResponseHandler(requestId: string): void {
    responseHandlers.delete(requestId);
}

/**
 * Envoie une frame d'ordre à un node connecté. Renvoie true si le socket est
 * OPEN + le write a pu être posté ; false si le node n'est pas joignable
 * (caller dégrade — pane endpoint fait un `event:unavailable`).
 */
export function sendToNode(nodeId: string, frame: PaneFrame): boolean {
    const ws = getProxyNodeSocket(nodeId);
    if (!ws) return false;
    try {
        ws.send(JSON.stringify(frame));
        return true;
    } catch {
        return false;
    }
}

/** Snapshot des nodes connectés (pour /api/nodes ou debug). */
export function listConnectedNodeIds(): string[] {
    return [...nodes.keys()].filter((id) => {
        const c = nodes.get(id);
        return c && c.socket.readyState === WebSocket.OPEN;
    });
}

/**
 * #510 — état détaillé du WS reverse pour un node donné, à surfacer dans le
 * NodeDetailPage (UI admin).
 *
 *  - `connected:false` quand le node n'est PAS dans la map (jamais connecté
 *    cette boot session du daemon, ou close()'d), ou est dans la map mais avec
 *    un socket non-OPEN (CLOSING/CLOSED). Distinct de `tokens.last_used_at`
 *    qui retourne la dernière activité HTTP+WS confondue.
 *  - `last_frame_at` est l'ISO de la dernière frame reçue (msg / hello / pong)
 *    sur le WS courant ; null si pas connecté.
 *  - `silent_for_sec` est l'âge de cette dernière frame en secondes — permet
 *    à l'UI de pister un node connecté mais qui ne ping plus (anomalie).
 */
export interface ProxyNodeWsState {
    connected: boolean;
    last_frame_at: string | null;
    silent_for_sec: number | null;
    /** #513 — version + commit reportés par le proxy dans `hello`. NULL
     *  quand non-connected ou avant le 1er hello ; comparable à
     *  `AIBALL_VERSION` côté upstream pour signaler un drift. */
    node_version: string | null;
    node_commit: string | null;
}

export function getProxyNodeWsState(nid: string): ProxyNodeWsState {
    const c = nodes.get(nid);
    if (!c || c.socket.readyState !== WebSocket.OPEN) {
        return {
            connected: false, last_frame_at: null, silent_for_sec: null,
            node_version: null, node_commit: null,
        };
    }
    return {
        connected: true,
        last_frame_at: new Date(c.last_frame_ms).toISOString(),
        silent_for_sec: Math.round((Date.now() - c.last_frame_ms) / 1000),
        node_version: c.node_version,
        node_commit: c.node_commit,
    };
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
    // #505 — noServer + manual upgrade dispatch. Le pattern `{server, path}`
    // ne marche PAS quand 2+ WebSocketServer path-scoped partagent le même
    // server : la lib appelle `handleUpgrade` UNCONDITIONNELLEMENT, qui
    // abort-handshake-400 sur path mismatch → destroy le socket avant que
    // les autres WSS puissent l'attraper. Le noServer évite ce piège.
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== PROXY_WS_PATH) return; // pas pour nous
        console.log(`[proxy WS] upgrade attempt: path=${url.pathname} peer=${req.socket?.remoteAddress}`);
        const ip = req.socket?.remoteAddress ?? null;
        const token = readBearer(req);
        if (!token) {
            console.warn(`[proxy WS] upgrade refused: no bearer (peer=${ip})`);
            socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
            socket.destroy();
            return;
        }
        const row = getToken(token);
        if (!row) {
            console.warn(`[proxy WS] upgrade refused: token not found (peer=${ip})`);
            socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
            socket.destroy();
            return;
        }
        if (row.kind !== "node") {
            console.warn(`[proxy WS] upgrade refused: token kind=${row.kind} (need 'node') peer=${ip}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }
        // Auth OK — handshake.
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req, { token, row, ip });
        });
    });

    wss.on("connection", (ws, _req, auth?: { token: string; row: NonNullable<ReturnType<typeof getToken>>; ip: string | null }) => {
        if (!auth) {
            try { ws.close(1011, "auth context missing"); } catch { /* */ }
            return;
        }
        const { token, row, ip } = auth;
        const nid = computeNodeId(token);
        setTokenLastSeenIp(token, ip);
        bumpLastUsed(token);
        const mapSizeBefore = nodes.size;
        const prev = nodes.get(nid);
        if (prev) {
            const prevAgeMs = Date.now() - prev.last_frame_ms;
            console.log(`[proxy WS] supersede: closing prev conn for id=${nid} (prev was ${(prevAgeMs / 1000).toFixed(1)}s since last frame, readyState=${prev.socket.readyState}, map_size=${mapSizeBefore})`);
            try { prev.socket.close(1000, "superseded"); } catch { /* noop */ }
        }
        const conn: ProxyNodeConn = {
            node_id: nid,
            token,
            socket: ws,
            last_frame_ms: Date.now(),
            node_version: null,
            node_commit: null,
        };
        nodes.set(nid, conn);
        console.log(`[proxy WS] node connected: id=${nid} label=${row.label ?? "(unset)"} peer=${ip} map_size_after=${nodes.size}`);
        try {
            ws.send(JSON.stringify({ kind: "hello", node_id: nid, server_ts: Date.now() }));
        } catch { /* noop — close prendra le relais */ }
        ws.on("message", (data) => {
            conn.last_frame_ms = Date.now();
            bumpLastUsed(token);
            let frame: PaneFrame;
            try { frame = JSON.parse(data.toString()) as PaneFrame; } catch { return; }
            if (frame.kind === "hello") {
                const nodeVer = typeof frame.version === "string" ? frame.version : "(unknown)";
                const nodeCommit = typeof frame.commit === "string" ? frame.commit : "(unknown)";
                const match = nodeVer === AIBALL_VERSION && nodeCommit === AIBALL_COMMIT;
                const tag = match ? "match" : "MISMATCH";
                // #524 : provider-resolved display_host. Frame légacy (pre-#524)
                // ne ship pas les champs → on persiste null/null (clear), normal.
                const dh = typeof frame.display_host === "string" ? frame.display_host : null;
                const dhProv = typeof frame.display_host_provider === "string" ? frame.display_host_provider : null;
                console.log(`[proxy WS] hello from id=${nid}: node v=${nodeVer} commit=${nodeCommit} display_host=${dh ?? "(none)"}${dhProv ? `/${dhProv}` : ""} | upstream v=${AIBALL_VERSION} commit=${AIBALL_COMMIT} → ${tag}`);
                // #513 — persiste la version sur la conn pour l'exposer côté UI
                // (NodeDetailPage). On stocke même "(unknown)" pour refléter
                // l'état exact (un proxy pre-version-frame se signale ainsi).
                conn.node_version = nodeVer;
                conn.node_commit = nodeCommit;
                setTokenDisplayHost(token, dh, dhProv);
            }
            if (typeof frame.request_id === "string") {
                const handler = responseHandlers.get(frame.request_id);
                if (handler) handler(frame);
            }
        });
        ws.on("pong", () => {
            conn.last_frame_ms = Date.now();
            bumpLastUsed(token);
            if (process.env.AIBALL_WS_TRACE) {
                console.log(`[proxy WS] pong from id=${nid}`);
            }
        });
        ws.on("close", (code, reason) => {
            const lifetimeSec = ((Date.now() - conn.last_frame_ms) / 1000).toFixed(1);
            console.log(`[proxy WS] node disconnected: id=${nid} label=${row.label ?? "(unset)"} code=${code} reason=${reason?.toString() || "(none)"} silent_for=${lifetimeSec}s`);
            if (nodes.get(nid) === conn) nodes.delete(nid);
        });
        ws.on("error", () => {
            try { ws.terminate(); } catch { /* noop */ }
        });
    });

    // Keepalive : ping toutes les 25s, terminate les conns non-pong à 60s.
    // Middleboxes (NAT, load balancers) coupent les TCP idle ~30-60s, ce ping
    // garde la conn warm. (Une tentative de descendre à 10s/30s pour défaire
    // un timeout d'intermédiaire #505 n'a rien changé — le cycle 70s persiste
    // au même pattern, donc le bug n'est pas du côté de notre keepalive.)
    const PING_INTERVAL_MS = 25_000;
    const STALE_MS = 60_000;
    const interval = setInterval(() => {
        const now = Date.now();
        for (const [nid, conn] of nodes) {
            if (conn.socket.readyState !== WebSocket.OPEN) {
                // #505 — close event didn't fire (TCP RST sans handshake, ou
                // close handler buggé) mais le socket est mort côté lib. On
                // log AVANT de remove pour que la disparition ne soit pas
                // silencieuse. Code 0 = inconnu (pas de code reçu).
                const stateName = conn.socket.readyState === WebSocket.CLOSING
                    ? "CLOSING" : conn.socket.readyState === WebSocket.CLOSED
                    ? "CLOSED" : conn.socket.readyState === WebSocket.CONNECTING
                    ? "CONNECTING" : String(conn.socket.readyState);
                const silentSec = ((now - conn.last_frame_ms) / 1000).toFixed(1);
                console.log(`[proxy WS] dead socket swept from map: id=${nid} state=${stateName} silent_for=${silentSec}s (close event never fired — TCP RST ?)`);
                nodes.delete(nid);
                continue;
            }
            if (now - conn.last_frame_ms > STALE_MS) {
                const silentSec = ((now - conn.last_frame_ms) / 1000).toFixed(1);
                console.log(`[proxy WS] terminating stale node: id=${nid} silent_for=${silentSec}s (no frame in ${STALE_MS / 1000}s window)`);
                try { conn.socket.terminate(); } catch { /* noop */ }
                nodes.delete(nid);
                continue;
            }
            try {
                conn.socket.ping();
                if (process.env.AIBALL_WS_TRACE) {
                    console.log(`[proxy WS] ping → id=${nid} silent_for=${((now - conn.last_frame_ms) / 1000).toFixed(1)}s`);
                }
            } catch { /* noop */ }
        }
    }, PING_INTERVAL_MS);
    interval.unref(); // ne pas garder le process en vie tout seul (tests)
    server.on("close", () => clearInterval(interval));
}
