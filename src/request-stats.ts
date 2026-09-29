/**
 * #2682 — which requests keep the daemon busy. The daemon serves one request
 * at a time, so a slow route delays every MCP and loop call behind it. This
 * counts, per route (method + path with ids folded), how many requests ran,
 * their total and worst duration, and the requests still running. #3243 — the
 * bus's methods too (`BUS <method>`), and the stalls of the event loop with the
 * calls that ran during them. An indicator only: nothing acts on it. Read it
 * with GET /api/debug/requests, or the bus's `debug.requests`.
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

/** #3000 — one request over 100 ms: enough to tell WHICH call was slow, and who made it. */
export interface SlowRequest {
    at: string;
    ms: number;
    route: string;
    /** The query string, a token in it masked. */
    query: string;
    /** The authenticated consumer, else the one the request named, else null. */
    consumer: string | null;
    /** The first word of the user agent: tells a browser from tvty or a CLI acting as the same human. */
    agent: string | null;
}
const SLOW_MS = 100;
const SLOW_KEPT = 100;
/** The latest slow requests, oldest first; bounded. */
const slow: SlowRequest[] = [];

/** `project=a&token=xyz` → `project=a&token=***`: the stats are readable by anyone on the socket. */
export function maskedQuery(url: string): string {
    const i = url.indexOf("?");
    if (i < 0) return "";
    return url.slice(i + 1).replace(/(^|&)(token|access_token)=[^&]*/gi, "$1$2=***");
}
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

/**
 * #3243 — one call, HTTP or bus, from its start: counted per key, kept among
 * the slow ones when over 100 ms, and remembered with its start and end so a
 * stall of the event loop can name the calls that were running during it.
 * Returns what ends it. A streaming response (SSE) is counted, not timed.
 */
export function beginCall(key: string, who: { consumer: string | null | (() => string | null); agent: string | null; query?: string }): (opts?: { streaming?: boolean }) => void {
    const consumerNow = (): string | null => (typeof who.consumer === "function" ? who.consumer() : who.consumer);
    const started = process.hrtime.bigint();
    const startedMs = Date.now();
    const call: RunningCall = { key, consumer: consumerNow(), startedMs };
    running.add(call);
    inFlight++;
    let done = false;
    return (opts = {}) => {
        if (done) return;
        done = true;
        inFlight--;
        running.delete(call);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const s = stats.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, over1s: 0, over100ms: 0 };
        s.count++;
        if (!opts.streaming) {
            s.totalMs += ms;
            s.maxMs = Math.max(s.maxMs, ms);
            if (ms > 1000) s.over1s++;
            if (ms > SLOW_MS) {
                s.over100ms++;
                slow.push({ at: new Date().toISOString(), ms: Math.round(ms), route: key, query: who.query ?? "", consumer: consumerNow(), agent: who.agent });
                if (slow.length > SLOW_KEPT) slow.shift();
            }
            finished.push({ key, consumer: consumerNow(), startedMs, endedMs: Date.now() });
            if (finished.length > FINISHED_KEPT) finished.shift();
        }
        stats.set(key, s);
    };
}

export function requestStatsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const named = req.header?.("x-aiball-consumer");
    const ua = req.header?.("user-agent");
    const end = beginCall(routeKey(req.method, req.originalUrl), {
        // The authenticated consumer once auth ran, else the one the request named.
        consumer: () => (req as { consumer_id?: string }).consumer_id || named?.trim() || null,
        agent: ua ? ua.split(/[\s/]/)[0]!.slice(0, 40) || null : null,
        query: maskedQuery(req.originalUrl),
    });
    const finish = () => end({ streaming: String(res.getHeader("content-type") ?? "").includes("text/event-stream") });
    res.on("finish", finish);
    res.on("close", finish);
    next();
}

/** A call running now. */
interface RunningCall { key: string; consumer: string | null; startedMs: number }
const running = new Set<RunningCall>();
/** Calls that ended lately, with when they ran: what a stall is matched against. */
interface FinishedCall { key: string; consumer: string | null; startedMs: number; endedMs: number }
const FINISHED_KEPT = 500;
const finished: FinishedCall[] = [];

/**
 * #3243 — a stall: the event loop held for longer than the threshold. A timer
 * due every 100 ms measures how late it runs; past the threshold (500 ms), the
 * stall is kept with the calls that ran during it — the ones that ended within
 * it as well as the ones still running, since a synchronous block has most
 * often returned by the time the timer can run. Logged too, for the journal.
 */
export interface Stall {
    at: string;
    ms: number;
    calls: { call: string; consumer: string | null; ms: number }[];
}
const STALL_TICK_MS = 100;
const STALLS_KEPT = 50;
const stalls: Stall[] = [];
function stallThresholdMs(): number {
    return Number(process.env.AIBALL_STALL_MS ?? 500);
}
let lastTick = Date.now();
const stallTimer = setInterval(() => checkStall(Date.now()), STALL_TICK_MS);
stallTimer.unref?.();

/** Exported for tests: what the timer does on each tick. */
export function checkStall(now: number): Stall | null {
    const late = now - lastTick - STALL_TICK_MS;
    const windowStart = lastTick;
    lastTick = now;
    if (late <= stallThresholdMs()) return null;
    const calls = [
        ...finished.filter((c) => c.endedMs >= windowStart && c.startedMs <= now).map((c) => ({ call: c.key, consumer: c.consumer, ms: c.endedMs - c.startedMs })),
        ...[...running].map((c) => ({ call: c.key, consumer: c.consumer, ms: now - c.startedMs })),
    ].sort((a, b) => b.ms - a.ms).slice(0, 10);
    const stall: Stall = { at: new Date(windowStart).toISOString(), ms: Math.round(late), calls };
    stalls.push(stall);
    if (stalls.length > STALLS_KEPT) stalls.shift();
    console.log(`[stall] the event loop was held ${stall.ms} ms at ${stall.at}${calls.length ? `, during: ${calls.map((c) => `${c.call} (${c.consumer ?? "?"}, ${c.ms} ms)`).join("; ")}` : ", no call running"}`);
    return stall;
}

/** Tests only: the tick clock and the kept stalls. */
export function resetStallsForTests(now = Date.now()): void {
    lastTick = now;
    stalls.length = 0;
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

export function requestStatsReport(): { since: string; in_flight: number; event_loop: EventLoopDelay; stalls: Stall[]; slow: SlowRequest[]; routes: Array<{ route: string; count: number; total_ms: number; avg_ms: number; max_ms: number; over_100ms: number; over_1s: number }> } {
    const routes = [...stats.entries()].map(([route, s]) => ({
        route,
        count: s.count,
        total_ms: Math.round(s.totalMs),
        avg_ms: s.count ? Math.round(s.totalMs / s.count) : 0,
        max_ms: Math.round(s.maxMs),
        over_100ms: s.over100ms,
        over_1s: s.over1s,
    })).sort((a, b) => b.total_ms - a.total_ms);
    // Newest first: the one being chased is usually the last.
    return { since, in_flight: inFlight, event_loop: eventLoopDelay(), stalls: [...stalls].reverse(), slow: [...slow].reverse(), routes };
}
