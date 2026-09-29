// #3360 — two agents never share a folder's conversation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationHolder, foreignAgentRefusal } from "./start-guards.js";

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
