/**
 * #1542 — the MCP upstream-tool surfacing gate: only for an OWNER of a project
 * that has an upstream binding configured. Pure unit test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSurfaceUpstreamTools } from "./upstream-visibility.js";

const ownerSub = { project: "p", role: "owner" };
const followerSub = { project: "p", role: "follower" };
const binding = { "p": [{ kind: "github", ref: "github:o/r", default: true }] };

test("owner + configured binding → surfaced", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: "p", upstream: binding, subs: [ownerSub] }), true);
});

test("configured but only follower → hidden (crew, not lead)", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: "p", upstream: binding, subs: [followerSub] }), false);
});

test("owner but no binding for the project → hidden", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: "p", upstream: {}, subs: [ownerSub] }), false);
});

test("owner but binding list empty → hidden", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: "p", upstream: { "p": [] }, subs: [ownerSub] }), false);
});

test("no project → hidden", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: null, upstream: binding, subs: [ownerSub] }), false);
});

test("owner of a DIFFERENT project → hidden", () => {
    assert.equal(shouldSurfaceUpstreamTools({
        project: "p",
        upstream: binding,
        subs: [{ project: "other", role: "owner" }],
    }), false);
});

test("undefined upstream map → hidden (fail closed)", () => {
    assert.equal(shouldSurfaceUpstreamTools({ project: "p", upstream: undefined, subs: [ownerSub] }), false);
});
