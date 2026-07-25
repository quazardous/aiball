/**
 * #1435 slice 2 — crew lifecycle pure core. Tests the planning layer (names,
 * paths, branch, identity, provision plan) and the `git worktree list`
 * porcelain parser — no git, no spawn (those are thin wrappers, covered by
 * --dry-run + manual/E2E).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isValidCrewName,
    crewBranch,
    crewAgentId,
    crewWorktreePath,
    crewProvisionPlan,
    parseWorktreeList,
    crewSkillStatus,
} from "./crew.js";

test("isValidCrewName accepts safe segments, rejects unsafe ones", () => {
    for (const ok of ["infra", "infra-2", "worker_1", "A1"]) assert.equal(isValidCrewName(ok), true, ok);
    for (const bad of ["", "-lead", "a/b", "a b", ".hidden", "a.b", "a:b"]) assert.equal(isValidCrewName(bad), false, bad);
});

test("branch / agent / path helpers follow house conventions", () => {
    assert.equal(crewBranch("infra"), "crew/infra");
    assert.equal(crewAgentId("aiball", "infra"), "aiball-crew-infra");
    assert.equal(crewWorktreePath("/home/x/aiball", "infra"), "/home/x/aiball/worktrees/infra");
});

test("crewProvisionPlan computes the full plan with default base HEAD", () => {
    const plan = crewProvisionPlan({ root: "/repo", project: "aiball", name: "infra" });
    assert.deepEqual(plan, {
        name: "infra",
        project: "aiball",
        agentId: "aiball-crew-infra",
        branch: "crew/infra",
        dir: "/repo/worktrees/infra",
        base: "HEAD",
    });
});

test("crewProvisionPlan honours an explicit base", () => {
    const plan = crewProvisionPlan({ root: "/repo", project: "aiball", name: "infra", base: "main" });
    assert.equal(plan.base, "main");
});

test("parseWorktreeList parses paths + strips refs/heads/ from branches", () => {
    const porcelain = [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo/worktrees/infra",
        "HEAD def456",
        "branch refs/heads/crew/infra",
        "",
    ].join("\n");
    const got = parseWorktreeList(porcelain);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { path: "/repo", branch: "main" });
    assert.deepEqual(got[1], { path: "/repo/worktrees/infra", branch: "crew/infra" });
});

test("parseWorktreeList handles a detached worktree (no branch)", () => {
    const got = parseWorktreeList("worktree /repo/wt\nHEAD abc123\ndetached\n");
    assert.deepEqual(got, [{ path: "/repo/wt", branch: null }]);
});

// #1435 slice 8 rework — crew skill self-check (david ncmf5u).
test("crewSkillStatus: absent → missing", () => {
    assert.equal(crewSkillStatus("shipped body", null), "missing");
});
test("crewSkillStatus: identical → ok", () => {
    assert.equal(crewSkillStatus("shipped body", "shipped body"), "ok");
});
test("crewSkillStatus: divergent → stale", () => {
    assert.equal(crewSkillStatus("shipped v2", "old v1"), "stale");
});
