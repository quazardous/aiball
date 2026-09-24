// #2682 — route keys fold ids so the stats group by route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeKey } from "./request-stats.js";

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
