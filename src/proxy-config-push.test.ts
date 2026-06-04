// #775 — proxy node config-push frame builder. The node reads a project
// `.aiball.yaml` and advertises `consumer.no_claim` to the upstream via a flat
// `node_project_config_push` frame (contract pinned by aiball-win `tb7mmq`),
// which the papy handler (`proxy-ws.ts`) turns into `consumers.can_claim`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigPushFrame } from "./proxy.js";

test("buildConfigPushFrame: graphite-style yaml (no project) → fallback project + no_claim", () => {
    const yaml = "consumer:\n  agent: aiball-win\n  no_claim: true\n";
    assert.deepEqual(buildConfigPushFrame(yaml, "aiball"), {
        kind: "node_project_config_push",
        project: "aiball",
        consumers: [{ agent: "aiball-win", no_claim: true }],
    });
});

test("buildConfigPushFrame: explicit consumer.project wins over the fallback", () => {
    const yaml = "consumer:\n  agent: a1\n  project: realproj\n  no_claim: false\n";
    const frame = buildConfigPushFrame(yaml, "fallback");
    assert.equal(frame?.project, "realproj");
    assert.deepEqual(frame?.consumers, [{ agent: "a1", no_claim: false }]);
});

test("buildConfigPushFrame: no_claim omitted → consumer carries no no_claim key (no implicit reset)", () => {
    const frame = buildConfigPushFrame("consumer:\n  agent: a1\n", "aiball");
    assert.deepEqual(frame, {
        kind: "node_project_config_push",
        project: "aiball",
        consumers: [{ agent: "a1" }],
    });
    assert.ok(frame && !("no_claim" in frame.consumers[0]));
});

test("buildConfigPushFrame: non-boolean no_claim is ignored", () => {
    const frame = buildConfigPushFrame("consumer:\n  agent: a1\n  no_claim: \"yes\"\n", "aiball");
    assert.ok(frame && !("no_claim" in frame.consumers[0]));
});

test("buildConfigPushFrame: no consumer block → null", () => {
    assert.equal(buildConfigPushFrame("autopoll:\n  enabled: true\n", "aiball"), null);
});

test("buildConfigPushFrame: consumer without agent → null", () => {
    assert.equal(buildConfigPushFrame("consumer:\n  no_claim: true\n", "aiball"), null);
});

test("buildConfigPushFrame: agent present but project unresolvable (no project + empty fallback) → null", () => {
    assert.equal(buildConfigPushFrame("consumer:\n  agent: a1\n", ""), null);
});

test("buildConfigPushFrame: malformed yaml → null (never throws)", () => {
    assert.equal(buildConfigPushFrame(":::not yaml:::\n  - [", "aiball"), null);
});
