// #2180 — `claude-loop start --type` sets the agent type before claude boots.
// It creates the record only when there is none (posting to an existing one
// would wipe its name and note), and a refusal becomes a warning, never a
// failed start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentType, type HumanConsumerClient } from "./agent-type.js";

function fakeClient(opts: { exists: boolean; failPatch?: string }) {
    const calls: string[] = [];
    const client: HumanConsumerClient = {
        async getConsumer(id) {
            calls.push(`get ${id}`);
            if (!opts.exists) throw new Error(`GET /api/consumers/${id} → 404: consumer not found`);
            return { consumer_id: id };
        },
        async upsertConsumer(input) { calls.push(`upsert ${input.consumer_id} ${input.kind}`); },
        async patchConsumer(id, patch) {
            calls.push(`patch ${id} ${patch.agent_type}`);
            if (opts.failPatch) throw new Error(opts.failPatch);
        },
    };
    return { client, calls };
}

test("an agent with no record yet: the record is created, then typed", async () => {
    const { client, calls } = fakeClient({ exists: false });
    assert.deepEqual(await applyAgentType({ agentId: "cto-1", type: "cto", human: client }), { ok: true });
    assert.deepEqual(calls, ["get cto-1", "upsert cto-1 agent", "patch cto-1 cto"]);
});

test("an agent that already has a record is only typed, never re-posted", async () => {
    const { client, calls } = fakeClient({ exists: true });
    assert.deepEqual(await applyAgentType({ agentId: "cto-1", type: "cto", human: client }), { ok: true });
    assert.deepEqual(calls, ["get cto-1", "patch cto-1 cto"]);
});

test("a daemon that refuses a non-human becomes a warning with the command to run", async () => {
    const { client } = fakeClient({ exists: true, failPatch: "PATCH /api/consumers/cto-1 → 403: consumer capability fields are human-only" });
    const v = await applyAgentType({ agentId: "cto-1", type: "cto", human: client });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.warning, /only lets a human set it.*aiball --human agent set cto-1 --type cto/);
});

test("any other failure is a warning too, and says the loop starts as coder", async () => {
    const { client } = fakeClient({ exists: true, failPatch: "connect ECONNREFUSED" });
    const v = await applyAgentType({ agentId: "cto-1", type: "cto", human: client });
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.warning, /starts as `coder`/);
});
