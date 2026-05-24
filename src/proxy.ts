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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parse as parseYaml } from "yaml";
import type { RequestHandler } from "express";
import { globalConfigPath } from "./autopoll/config.js";

export interface ProxyConfig {
    url: string;
    token: string;
}

/** Read the `proxy:` block from the GLOBAL config. Null when absent → the
 *  daemon runs in normal (local-DB) mode. */
export function loadProxy(): ProxyConfig | null {
    const p = globalConfigPath();
    if (!existsSync(p)) return null;
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as {
            proxy?: { url?: unknown; token?: unknown };
        };
        const px = raw.proxy;
        if (!px || typeof px !== "object") return null;
        const url = typeof px.url === "string" ? px.url.trim() : "";
        const token = typeof px.token === "string" ? px.token : "";
        if (!url) return null;
        return { url, token };
    } catch {
        return null;
    }
}

/**
 * A transparent streaming reverse-proxy middleware to the remote daemon.
 * Forwards method + path (`req.originalUrl`) + headers + body; injects the
 * bearer token; pipes the response back (works for JSON and SSE alike).
 */
export function proxyMiddleware(cfg: ProxyConfig): RequestHandler {
    const target = new URL(cfg.url);
    const reqFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    return (req, res) => {
        const headers: Record<string, string | string[] | undefined> = {
            ...req.headers,
            host: target.host,
        };
        // #394 QW-A: a caller that already carries its OWN bearer (a per-consumer
        // agent token, #390-style) keeps it → the upstream authenticates THAT
        // consumer with hard per-consumer proof, end-to-end through the proxy.
        // The node token is only a FALLBACK for genuinely token-less local
        // callers (web UI / CLI over the UDS) — then it vouches for the relayed
        // x-aiball-consumer (X-Forwarded-For model). So: per-consumer proof when
        // the caller has a token, node-vouched identity otherwise.
        if (cfg.token && !headers["authorization"]) {
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
