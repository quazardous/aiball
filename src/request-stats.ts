/**
 * #2682 — which requests keep the daemon busy. The daemon serves one request
 * at a time, so a slow route delays every MCP and loop call behind it. This
 * counts, per route (method + path with ids folded), how many requests ran,
 * their total and worst duration, and the requests still running. An
 * indicator only: nothing acts on it. Read it with GET /api/debug/requests.
 */
import type { Request, Response, NextFunction } from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";

interface RouteStat {
    count: number;
    totalMs: number;
    maxMs: number;
    over1s: number;
    over100ms: number;
}

const stats = new Map<string, RouteStat>();
const since = new Date().toISOString();
let inFlight = 0;

/**
 * #3000 — how long the event loop was held up: the daemon runs on one loop, so
 * while it is busy (a synchronous SQLite read, say) every agent, the web UI and
 * /ws wait. Sampled every 20 ms, since boot; read as a distribution.
 */
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

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
        const s = stats.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, over1s: 0, over100ms: 0 };
        s.count++;
        if (!streaming) {
            s.totalMs += ms;
            s.maxMs = Math.max(s.maxMs, ms);
            if (ms > 1000) s.over1s++;
            if (ms > 100) s.over100ms++;
        }
        stats.set(key, s);
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
}

/** The loop's delay, in milliseconds: how late a timer due now actually ran (0 = on time). */
export interface EventLoopDelay {
    p50_ms: number;
    p99_ms: number;
    max_ms: number;
    mean_ms: number;
}

function eventLoopDelay(): EventLoopDelay {
    // The histogram counts the sampling period itself: an idle loop reads 20 ms.
    // Take it off, so 0 means on time.
    const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);
    return {
        p50_ms: ms(loopDelay.percentile(50)),
        p99_ms: ms(loopDelay.percentile(99)),
        max_ms: ms(loopDelay.max),
        mean_ms: ms(loopDelay.mean),
    };
}

export function requestStatsReport(): { since: string; in_flight: number; event_loop: EventLoopDelay; routes: Array<{ route: string; count: number; total_ms: number; avg_ms: number; max_ms: number; over_100ms: number; over_1s: number }> } {
    const routes = [...stats.entries()].map(([route, s]) => ({
        route,
        count: s.count,
        total_ms: Math.round(s.totalMs),
        avg_ms: s.count ? Math.round(s.totalMs / s.count) : 0,
        max_ms: Math.round(s.maxMs),
        over_100ms: s.over100ms,
        over_1s: s.over1s,
    })).sort((a, b) => b.total_ms - a.total_ms);
    return { since, in_flight: inFlight, event_loop: eventLoopDelay(), routes };
}
