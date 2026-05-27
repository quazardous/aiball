/**
 * #394: aiball "proxy node" mode. A LOCAL daemon that transparently relays
 * to a REMOTE aiball over HTTP+token, so local clients (claude-loop, MCP, CLI,
 * web UI) keep talking to localhost / the UDS (token-less, SSE-over-UDS, all
 * features) while the data lives on the remote.
 *
 * Config is host-level → a `proxy:` block in the GLOBAL config
 * (`~/.config/aiball/config.yaml`), consistent with `providers:` (#354).
 *
 *   proxy:
 *     url: https://A-host:7777
 *     token: aiball-<…>      # mint on A with `aiball auth issue --consumer <id>`
 *
 * The relay is a pure stream forward: every `/api/*` and `/uploads/*` request
 * is piped to the remote with the bearer token injected; the local caller's
 * `x-aiball-consumer` header is preserved. Streaming covers SSE (`/api/events`)
 * for free — the chunked response just pipes through. No local DB in this mode.
 *
 * Resilience comes for free: when the remote is unreachable the proxy answers
 * 502, and the local AiballClient spools the write for replay (#389: 5xx/
 * transport → spool, 4xx → surfaced).
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parse as parseYaml } from "yaml";
import type { RequestHandler } from "express";
import { WebSocket } from "ws";
import { globalConfigPath } from "./autopoll/config.js";

export interface ProxyConfig {
    url: string;
    token: string;
    /**
     * #394 « tuer le point faible » : en mode strict le proxy n'injecte JAMAIS
     * le token node en fallback. Toute requête relayée DOIT porter son propre
     * bearer per-consumer, sinon 401. → le node ne peut plus *affirmer* une
     * identité (le token node n'est plus un passe-partout) ; A authentifie
     * chaque écriture per-consumer (preuve dure de bout en bout, via QW-A).
     * Opt-in (défaut false) : l'activer casse les clients token-less (web UI /
     * CLI sur l'UDS), qui doivent alors être provisionnés avec leur propre token.
     */
    strict?: boolean;
    /**
     * #463 — label declared by this proxy node, advertised to the upstream on
     * every forwarded request via `x-aiball-node-label`. The upstream daemon
     * updates its `tokens.label` on change, so renaming the node in the
     * config here is reflected in the Nodes panel without re-minting the
     * token. Default = `os.hostname()`, overridable via the YAML config :
     *
     *   proxy:
     *     url: …
     *     token: …
     *     node:
     *       label: "my-laptop"     # overrides hostname()
     */
    nodeLabel?: string;
}

/** Read the `proxy:` block from the GLOBAL config. Null when absent → the
 *  daemon runs in normal (local-DB) mode. */
export function loadProxy(): ProxyConfig | null {
    const p = globalConfigPath();
    if (!existsSync(p)) return null;
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as {
            proxy?: {
                url?: unknown;
                token?: unknown;
                strict?: unknown;
                node?: { label?: unknown };
            };
        };
        const px = raw.proxy;
        if (!px || typeof px !== "object") return null;
        const url = typeof px.url === "string" ? px.url.trim() : "";
        const token = typeof px.token === "string" ? px.token : "";
        const strict = px.strict === true;
        if (!url) return null;
        // #463 — read the node label override, fall back to the host's machine
        // name. The override empty-string OR missing → hostname (the default
        // makes a fresh proxy node immediately recognizable in the Nodes panel
        // without any extra config).
        const labelRaw = typeof px.node?.label === "string" ? px.node.label.trim() : "";
        const nodeLabel = labelRaw || hostname();
        return { url, token, strict, nodeLabel };
    } catch {
        return null;
    }
}

/**
 * #394 node-managed token store. One entry = a LOCAL token (handed to a local
 * client) mapped to an upstream per-consumer A-token (custody on the node). The
 * `consumer` is bookkeeping only (list/audit) — the A-token already proves the
 * consumer at A.
 */
export interface ProxyTokenEntry {
    local: string;
    remote: string;
    consumer: string;
}

/** In-memory view of the store, keyed by the LOCAL token for O(1) swap. */
export type ProxyTokenStore = Map<string, { remote: string; consumer: string }>;

/** Path of the node-managed token store (next to the global config). */
export function proxyTokensPath(): string {
    return join(dirname(globalConfigPath()), "proxy-tokens.yaml");
}

/**
 * #394 node-managed token store: read the `{local→{remote,consumer}}` mappings
 * the proxy uses to SWAP an incoming local bearer for the upstream per-consumer
 * A-token. Empty map when the file is absent/invalid → no swap, base behaviour
 * (never crash the proxy on a malformed store).
 */
export function loadProxyTokens(): ProxyTokenStore {
    const p = proxyTokensPath();
    const store: ProxyTokenStore = new Map();
    if (!existsSync(p)) return store;
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as {
            tokens?: Array<{ local?: unknown; remote?: unknown; consumer?: unknown }>;
        };
        for (const e of raw.tokens ?? []) {
            const local = typeof e.local === "string" ? e.local.trim() : "";
            const remote = typeof e.remote === "string" ? e.remote.trim() : "";
            const consumer = typeof e.consumer === "string" ? e.consumer.trim() : "";
            if (local && remote) store.set(local, { remote, consumer });
        }
    } catch {
        /* malformed store → behave as if empty */
    }
    return store;
}

/**
 * A transparent streaming reverse-proxy middleware to the remote daemon.
 * Forwards method + path (`req.originalUrl`) + headers + body; injects the
 * bearer token; pipes the response back (works for JSON and SSE alike).
 *
 * `tokens` is the node-managed store (#394) — defaults to `loadProxyTokens()`,
 * injectable for tests. A request whose bearer matches a local token is
 * rewritten to carry the mapped upstream A-token before forwarding.
 */
export function proxyMiddleware(cfg: ProxyConfig, tokens?: ProxyTokenStore): RequestHandler {
    const store = tokens ?? loadProxyTokens();
    const target = new URL(cfg.url);
    const reqFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    return (req, res) => {
        const headers: Record<string, string | string[] | undefined> = {
            ...req.headers,
            host: target.host,
        };
        // #463 — advertise this node's label on every forwarded request so the
        // upstream daemon's `tokens.label` tracks the node's current config (a
        // rename here is picked up at next request, no re-mint needed). Skip
        // when not set (shouldn't happen — loadProxy() defaults to hostname()
        // — but defensive).
        if (cfg.nodeLabel) headers["x-aiball-node-label"] = cfg.nodeLabel;
        // #394 node-managed store : si le bearer entrant est un token LOCAL
        // connu, on le SWAP contre le token A per-consumer mappé → A reçoit la
        // preuve dure per-consumer (le token A est la preuve), et ce token A ne
        // vit jamais côté client (custody sur le node). Un bearer inconnu (le
        // client porte déjà son propre token A, cf QW-A) passe tel quel.
        const incoming = headers["authorization"];
        if (store.size > 0 && typeof incoming === "string") {
            const m = /^Bearer\s+(.+)$/i.exec(incoming);
            const mapped = m ? store.get(m[1].trim()) : undefined;
            if (mapped) headers["authorization"] = `Bearer ${mapped.remote}`;
        }
        // #394 « tuer le point faible » : en mode strict, le node n'a plus le
        // droit d'affirmer une identité. Une requête sans son propre bearer
        // per-consumer est rejetée ICI (401) — on ne forwarde pas, on n'injecte
        // pas le token node. Plus de passe-partout réseau ⇒ le point faible
        // cross-host disparaît (cf docs/SECURITY.md).
        if (cfg.strict && !headers["authorization"]) {
            res.status(401).json({
                error: "proxy strict mode: a per-consumer bearer token is required "
                    + "(the node token is not injected as a fallback in strict mode)",
            });
            return;
        }
        // #394 QW-A: a caller that already carries its OWN bearer (a per-consumer
        // agent token, #390-style) keeps it → the upstream authenticates THAT
        // consumer with hard per-consumer proof, end-to-end through the proxy.
        // The node token is only a FALLBACK for genuinely token-less local
        // callers (web UI / CLI over the UDS) — then it vouches for the relayed
        // x-aiball-consumer (X-Forwarded-For model). So: per-consumer proof when
        // the caller has a token, node-vouched identity otherwise. (Disabled in
        // strict mode — the early return above already 401'd any token-less call.)
        if (!cfg.strict && cfg.token && !headers["authorization"]) {
            headers["authorization"] = `Bearer ${cfg.token}`;
        }
        const upstream = reqFn(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port,
                method: req.method,
                path: req.originalUrl,
                headers,
            },
            (up) => {
                res.writeHead(up.statusCode ?? 502, up.headers);
                up.pipe(res);
            },
        );
        upstream.on("error", (e) => {
            if (!res.headersSent) {
                res.status(502).json({ error: `proxy upstream unreachable: ${(e as Error).message}` });
            } else {
                res.end();
            }
        });
        // Stream the request body straight through (no body parsing in proxy mode).
        req.pipe(upstream);
    };
}

/**
 * #505 — canal inverse WS pour le proxy node. Remplace l'ancien HTTP heartbeat
 * (#502) : la WS PERSISTANTE elle-même sert de signal de liveness (chaque
 * frame reçue côté upstream bumpe `tokens.last_used_at` qui alimente la
 * pastille up/down) ET portera les ordres pane (phase 2). David `medh7z` :
 * "ok pour A. et du coup ça simplifie le heartbeat".
 *
 * Réconnect avec backoff exponentiel borné, et on advertise le label au handshake
 * comme on le faisait sur chaque request HTTP forwardée (auth middleware lit
 * `x-aiball-node-label` pour syncer la row tokens — ici on l'envoie en
 * première frame `hello`, le serveur fait la même mise à jour).
 *
 * Retourne un handle qui ferme la connexion + arrête les retries au shutdown.
 */
export interface ProxyWsClientHandle {
    close: () => void;
    isOpen: () => boolean;
}

export function startProxyWsClient(cfg: ProxyConfig): ProxyWsClientHandle {
    // Convertit l'URL http(s):// → ws(s):// pour le canal WS.
    let wsUrl: string;
    try {
        const u = new URL("/ws/proxy-node", cfg.url);
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = u.toString();
    } catch {
        return { close: () => {}, isOpen: () => false };
    }

    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let attempt = 0;

    const MIN_BACKOFF_MS = 1_000;
    const MAX_BACKOFF_MS = 60_000;

    function backoffMs(): number {
        // 1s, 2s, 4s, 8s, 16s, 32s, 60s cap.
        const ms = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(attempt, 6));
        attempt += 1;
        return ms;
    }

    function connect(): void {
        if (stopped) return;
        try {
            ws = new WebSocket(wsUrl, {
                headers: {
                    authorization: `Bearer ${cfg.token}`,
                },
                handshakeTimeout: 10_000,
            });
        } catch {
            scheduleReconnect();
            return;
        }
        ws.on("open", () => {
            attempt = 0; // succès → reset le backoff
            // Hello + label : on advertise le label au handshake comme on le
            // faisait sur le header `x-aiball-node-label` de chaque request
            // HTTP forwardée. Le serveur fera la même sync de `tokens.label`.
            try {
                ws?.send(JSON.stringify({
                    kind: "hello",
                    label: cfg.nodeLabel ?? null,
                    client_ts: Date.now(),
                }));
            } catch { /* noop — le close handler reprendra */ }
        });
        ws.on("close", () => { scheduleReconnect(); });
        ws.on("error", () => { /* silencieux : le close suit + reconnect */ });
        ws.on("ping", () => {
            // Le `ws` lib auto-pong, mais en explicit ça reset le timer interne.
        });
    }

    function scheduleReconnect(): void {
        if (stopped || reconnectTimer) return;
        const delay = backoffMs();
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
        reconnectTimer.unref();
    }

    connect();

    return {
        close: () => {
            stopped = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (ws) {
                try { ws.close(1000, "shutdown"); } catch { /* noop */ }
            }
        },
        isOpen: () => ws?.readyState === WebSocket.OPEN,
    };
}

/** Minimal HTML escaping for the operator-controlled proxy URL. */
function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * #394 (8c7xut): in proxy mode the web UI is degraded (the live `/ws` socket
 * stays local) and would only mirror the remote — so instead of the SPA we
 * serve this tiny self-contained landing page: "this daemon is a proxy of
 * <url>", with a link to the real UI. No build artifact needed.
 */
export function proxyLandingHtml(url: string): string {
    const u = esc(url);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aiball — proxy mode</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;
       display:grid;place-items:center;min-height:100vh;margin:0}
  .card{text-align:center;max-width:34rem;padding:2rem}
  .tag{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:#7fa8b8}
  h1{font-size:1.4rem;margin:.4rem 0 .8rem}
  p{line-height:1.5;color:#b9c0cc}
  code{background:#1b1f27;padding:.15rem .45rem;border-radius:.35rem;color:#e6e6e6}
  a.btn{display:inline-block;margin-top:1.4rem;padding:.6rem 1.1rem;border-radius:.5rem;
        background:#2563eb;color:#fff;text-decoration:none;font-weight:600}
  a.btn:hover{background:#1d4ed8}
</style></head>
<body><div class="card">
  <div class="tag">aiball · proxy mode</div>
  <h1>This daemon is a proxy</h1>
  <p>It transparently relays everything to a remote aiball — no data lives here.
     Local clients (loop, MCP, CLI) keep talking to it as usual.</p>
  <p>Relaying to <code>${u}</code></p>
  <a class="btn" href="${u}">Open the remote aiball →</a>
</div></body></html>
`;
}
