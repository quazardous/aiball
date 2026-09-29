// #2682 — route keys fold ids so the stats group by route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskedQuery, routeKey } from "./request-stats.js";

test("ids, hashes, consumers and projects fold into the route", () => {
    assert.equal(routeKey("POST", "/api/tickets/2640/assign?x=1"), "POST /api/tickets/:id/assign");
    assert.equal(routeKey("GET", "/api/messages/1023143"), "GET /api/messages/:id");
    assert.equal(routeKey("GET", "/api/consumers/claude-aiball-dev/wait-credit"), "GET /api/consumers/:consumer/wait-credit");
    assert.equal(routeKey("GET", "/api/projects/BookShepherd/standing-prompt"), "GET /api/projects/:project/standing-prompt");
    assert.equal(routeKey("GET", "/api/tickets?project=aiball&backlog=1"), "GET /api/tickets");
});

// #3000 — the report says how long the event loop was held up, and which
// routes took more than 100 ms.
test("a blocked loop shows in event_loop, and a slow route in over_100ms", async () => {
    const { requestStatsMiddleware, requestStatsReport } = await import("./request-stats.js");
    // Let the sampler tick a few times, then hold the loop for ~150 ms.
    await new Promise((r) => setTimeout(r, 60));
    const until = Date.now() + 150;
    while (Date.now() < until) { /* block */ }
    await new Promise((r) => setTimeout(r, 60));
    const loop = requestStatsReport().event_loop;
    assert.ok(loop.max_ms >= 80, `the 150 ms block is seen: ${JSON.stringify(loop)}`);
    assert.ok(loop.p50_ms < loop.max_ms, "most samples are not the block");

    // A route that takes ~120 ms counts in over_100ms, not in over_1s.
    const listeners: Record<string, () => void> = {};
    const res = { on: (ev: string, fn: () => void) => { listeners[ev] = fn; }, getHeader: () => "application/json" };
    requestStatsMiddleware({ method: "GET", originalUrl: "/api/slow-3000" } as never, res as never, () => {});
    await new Promise((r) => setTimeout(r, 120));
    listeners.finish();
    const row = requestStatsReport().routes.find((r) => r.route === "GET /api/slow-3000");
    assert.equal(row?.over_100ms, 1);
    assert.equal(row?.over_1s, 0);
});

// #3000 — a slow request is kept with its query and its caller, token masked.
test("a slow request is kept with its query, its caller and its agent, a token masked", async () => {
    const { requestStatsMiddleware, requestStatsReport } = await import("./request-stats.js");
    const listeners: Record<string, () => void> = {};
    const res = { on: (ev: string, fn: () => void) => { listeners[ev] = fn; }, getHeader: () => "application/json" };
    const headers: Record<string, string> = { "x-aiball-consumer": "david", "user-agent": "tvty/0.1 (linux)" };
    const req = { method: "GET", originalUrl: "/api/inbox?project=aiball&token=s3cret&open=1", header: (h: string) => headers[h] };
    requestStatsMiddleware(req as never, res as never, () => {});
    await new Promise((r) => setTimeout(r, 120));
    listeners.finish();
    const hit = requestStatsReport().slow.find((s) => s.route === "GET /api/inbox");
    assert.ok(hit, "the slow request is kept");
    assert.equal(hit.query, "project=aiball&token=***&open=1");
    assert.equal(hit.consumer, "david");
    assert.equal(hit.agent, "tvty");
    assert.ok(hit.ms >= 100);
});

test("a fast request is not kept, and a query without a token is left as is", async () => {
    assert.equal(maskedQuery("/api/tickets?project=a&open=1"), "project=a&open=1");
    assert.equal(maskedQuery("/ws?token=abc"), "token=***");
    assert.equal(maskedQuery("/api/health"), "");
    const { requestStatsMiddleware, requestStatsReport } = await import("./request-stats.js");
    const listeners: Record<string, () => void> = {};
    const res = { on: (ev: string, fn: () => void) => { listeners[ev] = fn; }, getHeader: () => "application/json" };
    requestStatsMiddleware({ method: "GET", originalUrl: "/api/fast-3000?x=1", header: () => undefined } as never, res as never, () => {});
    listeners.finish();
    assert.equal(requestStatsReport().slow.some((s) => s.route === "GET /api/fast-3000"), false);
});

// #3243 — the bus's methods in the same stats, and a stall of the event loop named with the call that held it.
test("a bus method call is counted and timed as BUS <method>, with its caller", async () => {
    const { defineMethod } = await import("./bus/methods.js");
    const { runOne } = await import("./bus/rpc.js");
    const { requestStatsReport } = await import("./request-stats.js");
    const { z } = await import("zod");
    defineMethod({ name: "test.stats_probe", who: ["human", "agent"], params: z.object({}), run: () => ({ ok: true }) });
    await runOne({ consumer_id: "probe-agent", kind: "agent", token_kind: "agent", transport: "uds", token: null, relayed: false }, { jsonrpc: "2.0", id: 1, method: "test.stats_probe" });
    const row = requestStatsReport().routes.find((r) => r.route === "BUS test.stats_probe");
    assert.equal(row?.count, 1);
});

test("a stall names the call that ran during it", async () => {
    const { beginCall, checkStall, resetStallsForTests, requestStatsReport } = await import("./request-stats.js");
    resetStallsForTests();
    // All synchronous: the background tick cannot run between the block and the check.
    const end = beginCall("BUS test.block", { consumer: "blocker", agent: null });
    const until = Date.now() + 700;
    while (Date.now() < until) { /* hold the event loop, as a synchronous read would */ }
    end();
    const stall = checkStall(Date.now());
    assert.ok(stall && stall.ms >= 500, `a stall of about 700 ms: ${JSON.stringify(stall)}`);
    assert.deepEqual(stall!.calls[0]!.call, "BUS test.block");
    assert.equal(stall!.calls[0]!.consumer, "blocker");
    assert.equal(requestStatsReport().stalls[0]!.ms, stall!.ms, "kept in the report, newest first");
    assert.equal(checkStall(Date.now()), null, "no stall right after: the tick is on time");
});
