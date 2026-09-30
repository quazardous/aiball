// #3360 — two agents never share a folder's conversation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { conversationHolder, foreignAgentRefusal, startFolder, takeLaunchCwd } from "./start-guards.js";

const root = mkdtempSync(join(tmpdir(), "aiball-3360-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a folder whose .aiball.yaml names its agent refuses another agent, not a crew of it", () => {
    const base = { folderAgent: "claude-aiball-dev", agentSource: "aiball.yaml", cwd: "/w/aiball" };
    assert.match(foreignAgentRefusal({ ...base, agent: "BookShepherd-claude", role: undefined })!, /BookShepherd-claude does not run in \/w\/aiball: its \.aiball\.yaml is claude-aiball-dev's/);
    assert.equal(foreignAgentRefusal({ ...base, agent: "claude-aiball-dev", role: undefined }), null, "its own agent");
    assert.equal(foreignAgentRefusal({ ...base, agent: "infra", role: "crew" }), null, "a crew of it");
    assert.equal(foreignAgentRefusal({ ...base, agent: undefined, role: undefined }), null, "no --agent: the folder's");
    assert.equal(foreignAgentRefusal({ ...base, agentSource: "default", agent: "other", role: undefined }), null, "a folder that names no agent");
});

test("a conversation another agent's running loop is on is not resumed; one's own, a stopped one's, is", () => {
    for (const n of ["cl-aiball", "cl-book", "cl-dead"]) mkdirSync(join(root, n));
    const plates: Record<string, object> = {
        "cl-aiball": { agent: "claude-aiball-dev", session_id: "S1" },
        "cl-book": { agent: "BookShepherd-claude", session_id: "S2" },
        "cl-dead": { agent: "old-agent", session_id: "S3" },
    };
    const alive = (name: string) => name !== "cl-dead";
    const plateOf = (name: string) => plates[name] as never;
    assert.deepEqual(conversationHolder("S1", "BookShepherd-claude", alive, root, plateOf), { name: "cl-aiball", agent: "claude-aiball-dev" });
    assert.equal(conversationHolder("S1", "claude-aiball-dev", alive, root, plateOf), null, "its own loop");
    assert.equal(conversationHolder("S3", "someone", alive, root, plateOf), null, "a stopped loop holds nothing");
    assert.equal(conversationHolder("S9", "someone", alive, root, plateOf), null);
});

// The launcher moves the process into the install root before the CLI runs:
// a start without `--cwd` took that root for its folder, and ran every loop
// in aiball's own folder, on its conversation.
test("a loop starts where the command was typed, or in --cwd relative to it", () => {
    const typed = join(root, "typed");
    assert.equal(startFolder(undefined, typed), typed);
    assert.equal(startFolder("sub", typed), resolve(typed, "sub"));
    assert.equal(startFolder(root, typed), root, "an absolute --cwd stands");
});

test("the recorded folder is read once and dropped: a child never inherits it", () => {
    const env: NodeJS.ProcessEnv = { AIBALL_LAUNCH_CWD: "/typed/here" };
    assert.equal(takeLaunchCwd(env), "/typed/here");
    assert.equal("AIBALL_LAUNCH_CWD" in env, false);
    assert.equal(takeLaunchCwd(env), process.cwd(), "without the launcher: this process's folder");
});

test("through the launcher: --cwd is resolved from the folder the command was typed in", () => {
    const typed = join(root, "typed-e2e");
    mkdirSync(typed, { recursive: true });
    const bin = resolve(import.meta.dirname, "..", "..", "bin", "claude-loop");
    // A folder inherited from another loop's shell must not win either.
    const r = spawnSync(process.execPath, [bin, "start", "--cwd", "not-there"], {
        cwd: typed, encoding: "utf8", env: { ...process.env, AIBALL_LAUNCH_CWD: "/inherited", AIBALL_CWD: "/inherited" },
    });
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes(`--cwd path does not exist: ${join(typed, "not-there")}`), r.stderr + r.stdout);
});
