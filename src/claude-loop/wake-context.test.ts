// #1098 — `fetchWakeContext` must resolve the triggering comment's body
// PIVOT-IMMUNE. The bug: it used a `brief` ticket read (pivot-cut, lossy) +
// find-by-hashid, so a `summary_until` landing between the ping and the
// (deferred) wake delivery dropped the human comment under the pivot → empty
// body → wake rendered bare refs `(#T / #hashid)`. The fix refetches the
// exact message by id (`getMessage`), which is snapshot-independent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWakeContext, pingIsDeliverable } from "./wake-context.js";
import type { AiballClient } from "../client.js";
import type { WakeHint } from "./state.js";

type Calls = { getTicketOpts: Array<Record<string, unknown> | undefined>; getMessageIds: number[] };

function stubClient(
    over: Partial<Record<string, unknown>> = {},
): { client: AiballClient; calls: Calls } {
    const calls: Calls = { getTicketOpts: [], getMessageIds: [] };
    const base: Record<string, unknown> = {
        agentId: "claude-test",
        getTicket: async (_id: number, opts?: Record<string, unknown>) => {
            calls.getTicketOpts.push(opts);
            return { ticket: { claimant: null, assignee: null } };
        },
        getMessage: async (id: number) => {
            calls.getMessageIds.push(id);
            return { body: "the real comment body" };
        },
        ...over,
    };
    return { client: base as unknown as AiballClient, calls };
}

const HINT: WakeHint = { ticket_id: 1095, comment_id: 1009269, comment_hashid: "6mny76" };

test("#1098 body resolved via getMessage(comment_id), NOT via brief", async () => {
    const { client, calls } = stubClient();
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.commentBody, "the real comment body");
    // getMessage was used for the body…
    assert.deepEqual(calls.getMessageIds, [1009269]);
    // …and the ticket read was `summary` (header-only), never `brief`.
    assert.equal(calls.getTicketOpts.length, 1);
    assert.equal(calls.getTicketOpts[0]?.summary, true);
    assert.notEqual(calls.getTicketOpts[0]?.brief, true);
});

test("#1098 repro — brief would drop the comment (under pivot) but getMessage still returns it", async () => {
    // Simulate the exact failure: a brief read returns NO matching comment
    // (pivot moved past it), yet getMessage still serves the body.
    const { client } = stubClient({
        getTicket: async (_id: number, opts?: Record<string, unknown>) => {
            if (opts?.brief) return { ticket: {}, comments: [] }; // pivot dropped it
            return { ticket: { claimant: null, assignee: null } };
        },
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.commentBody, "the real comment body");
});

test("#1098 fallback: no comment_id → brief find-by-hashid (no regression on old daemon)", async () => {
    const { client, calls } = stubClient({
        getMessage: async () => { throw new Error("should not be called without comment_id"); },
        getTicket: async (_id: number, opts?: Record<string, unknown>) => {
            if (opts?.brief) {
                return { ticket: {}, comments: [{ hashid: "6mny76", body: "legacy brief body" }] };
            }
            return { ticket: { claimant: null, assignee: null } };
        },
    });
    const hint: WakeHint = { ticket_id: 1095, comment_hashid: "6mny76" }; // no comment_id
    const ctx = await fetchWakeContext(client, hint, "claude-test");
    assert.equal(ctx.commentBody, "legacy brief body");
    assert.equal(calls.getMessageIds.length, 0);
});

test("#1098 stakeholder: claimant === me (body empty) still wakes", async () => {
    const { client } = stubClient({
        getMessage: async () => ({ body: "" }),
        getTicket: async () => ({ ticket: { claimant: "claude-test", assignee: null } }),
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.stakeholder, true);
    assert.equal(ctx.commentBody, undefined);
});

test("#1098 stakeholder: @-mention in the comment body", async () => {
    const { client } = stubClient({
        getMessage: async () => ({ body: "hey @claude-test can you look" }),
        getTicket: async () => ({ ticket: { claimant: null, assignee: null } }),
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.stakeholder, true);
    assert.match(ctx.commentBody ?? "", /@claude-test/);
});

test("#1098 not stakeholder: not claimant/assignee, no mention", async () => {
    const { client } = stubClient({
        getTicket: async () => ({ ticket: { claimant: "someone-else", assignee: null } }),
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.stakeholder, false);
    // body is still resolved (caller decides whether to use it)
    assert.equal(ctx.commentBody, "the real comment body");
});

test("#1098 fail-open: getTicket throws → stakeholder true, body empty", async () => {
    const { client } = stubClient({
        getTicket: async () => { throw new Error("daemon down"); },
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.stakeholder, true);
    assert.equal(ctx.commentBody, undefined);
});

test("#1098 getMessage failure is best-effort: ticket ok → verdict stands, body empty", async () => {
    const { client } = stubClient({
        getMessage: async () => { throw new Error("message fetch failed"); },
        getTicket: async () => ({ ticket: { claimant: "claude-test", assignee: null } }),
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.stakeholder, true);
    assert.equal(ctx.commentBody, undefined);
});

test("#1098 no me / no ticket_id → trivially stakeholder, no fetch", async () => {
    const { client, calls } = stubClient();
    assert.deepEqual(await fetchWakeContext(client, HINT, undefined), { stakeholder: true });
    assert.deepEqual(await fetchWakeContext(client, {}, "claude-test"), { stakeholder: true });
    assert.equal(calls.getTicketOpts.length, 0);
});

// #1351 — fetchWakeContext surfaces the ticket's project so the SSE handler can
// gate the hint on deliverability (pingIsDeliverable).
test("#1351 fetchWakeContext returns the ticket project", async () => {
    const { client } = stubClient({
        getTicket: async () => ({ ticket: { claimant: null, assignee: null, project: "runic" } }),
    });
    const ctx = await fetchWakeContext(client, HINT, "claude-test");
    assert.equal(ctx.project, "runic");
});

// #1351 david `hhqd9a` — the phantom fix : a ping only arms the wake countdown
// when it's DELIVERABLE (same project OR stakeholder). A cross-project,
// non-stakeholder broadcast must NOT arm (the runic b:0 e:0 loop).
test("#1351 pingIsDeliverable: same project → deliverable (even if not stakeholder)", () => {
    assert.equal(pingIsDeliverable({ project: "runic", stakeholder: false }, "runic"), true);
});
test("#1351 pingIsDeliverable: cross-project + stakeholder → deliverable", () => {
    assert.equal(pingIsDeliverable({ project: "aiball", stakeholder: true }, "runic"), true);
});
test("#1351 pingIsDeliverable: cross-project + NOT stakeholder → NOT deliverable (the phantom ping)", () => {
    assert.equal(pingIsDeliverable({ project: "aiball", stakeholder: false }, "runic"), false);
});
test("#1351 pingIsDeliverable: fail-open — unresolved project but stakeholder=true stays deliverable", () => {
    assert.equal(pingIsDeliverable({ project: undefined, stakeholder: true }, "runic"), true);
});
