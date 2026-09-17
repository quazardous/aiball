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
