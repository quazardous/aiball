/**
 * #2682 — which requests keep the daemon busy. The daemon serves one request
 * at a time, so a slow route delays every MCP and loop call behind it. This
 * counts, per route (method + path with ids folded), how many requests ran,
 * their total and worst duration, and the requests still running. An
 * indicator only: nothing acts on it. Read it with GET /api/debug/requests.
 */
import type { Request, Response, NextFunction } from "express";

interface RouteStat {
    count: number;
    totalMs: number;
    maxMs: number;
    over1s: number;
}

const stats = new Map<string, RouteStat>();
const since = new Date().toISOString();
let inFlight = 0;

/** `/api/tickets/2640/assign?x=1` → `/api/tickets/:id/assign`. SSE streams are reported apart. */
export function routeKey(method: string, url: string): string {
    const path = url.split("?")[0]
        .replace(/\/\d+(?=\/|$)/g, "/:id")
        .replace(/\/[0-9a-f]{32,64}(?=\.|\/|$)/gi, "/:hash")
        .replace(/\/consumers\/[^/]+/, "/consumers/:consumer")
        .replace(/\/projects\/[^/]+/, "/projects/:project");
    return `${method} ${path}`;
}

export function requestStatsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const key = routeKey(req.method, req.originalUrl);
    inFlight++;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        inFlight--;
        // A streaming response (SSE) stays open for minutes: count it, not its duration.
        const streaming = String(res.getHeader("content-type") ?? "").includes("text/event-stream");
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const s = stats.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, over1s: 0 };
        s.count++;
        if (!streaming) {
            s.totalMs += ms;
            s.maxMs = Math.max(s.maxMs, ms);
            if (ms > 1000) s.over1s++;
        }
        stats.set(key, s);
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
}

export function requestStatsReport(): { since: string; in_flight: number; routes: Array<{ route: string; count: number; total_ms: number; avg_ms: number; max_ms: number; over_1s: number }> } {
    const routes = [...stats.entries()].map(([route, s]) => ({
        route,
        count: s.count,
        total_ms: Math.round(s.totalMs),
        avg_ms: s.count ? Math.round(s.totalMs / s.count) : 0,
        max_ms: Math.round(s.maxMs),
        over_1s: s.over1s,
    })).sort((a, b) => b.total_ms - a.total_ms);
    return { since, in_flight: inFlight, routes };
}
