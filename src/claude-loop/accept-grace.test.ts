// #3898 — a plan accept's wake waits out a short grace, so the comment the
// human types right after accepting ("accepted, but mind X") arrives in the
// same wake instead of a second one, after the work has started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptGraceHoldUntil, buildContextPhrase } from "./state.js";
import type { AiballClient } from "../client.js";

const PINGS_YAML = new URL("../../config/defaults/claude-loop-pings.yaml", import.meta.url).pathname;

function client(messages: unknown[]): AiballClient {
    return {
        agentId: "claude-test",
        pingsCount: async () => ({ unread: messages.length }),
        listProjectsDetailed: async () => [{ name: "aiball", open_count: 1, actionable_count: 1 }],
        unread: async () => ({ messages }),
        getConsumer: async () => null,
        listTickets: async () => [],
        getTicket: async () => ({ ticket: { title: "accepted one", claimable: true } }),
        getProjectStandingPrompt: async () => null,
    } as unknown as AiballClient;
}
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

test("the grace holds a plan accept younger than it, and nothing else", () => {
    const now = Date.parse("2026-10-12T10:00:30.000Z");
    const head = (kind: string, at: string) => ({ kind, created_at: at });
    assert.equal(acceptGraceHoldUntil(head("plan_accepted", "2026-10-12T10:00:10.000Z"), 30, now), Date.parse("2026-10-12T10:00:40.000Z"));
    assert.equal(acceptGraceHoldUntil(head("plan_accepted", "2026-10-12T10:00:00.000Z"), 30, now), null, "the grace is over");
    assert.equal(acceptGraceHoldUntil(head("plan_accepted", "2026-10-12T10:00:10.000Z"), 0, now), null, "0 turns it off");
    for (const kind of ["comment_added", "plan_rejected", "resolution_accepted"]) {
        assert.equal(acceptGraceHoldUntil(head(kind, "2026-10-12T10:00:29.000Z"), 30, now), null, kind);
    }
    assert.equal(acceptGraceHoldUntil({ kind: "plan_accepted" }, 30, now), null, "no date: no hold");
    assert.equal(acceptGraceHoldUntil(undefined, 30, now), null);
});

test("a fresh accept: no wake yet, and the wake says until when", async () => {
    const res = await buildContextPhrase(client([
        { id: 901, kind: "plan_accepted", ticket_id: 3898, hashid: "pl1", by_agent: "david", created_at: ago(5) },
    ]), null, PINGS_YAML);
    assert.equal(res.hasContent, false);
    assert.equal(res.phrase, "");
    assert.equal(res.headMessageId, null, "nothing is acked while it waits");
    assert.ok(res.holdUntilMs && res.holdUntilMs > Date.now());
});

test("past the grace, the accept and the comment typed after it are one wake, both acked", async () => {
    const res = await buildContextPhrase(client([
        { id: 901, kind: "plan_accepted", ticket_id: 3898, hashid: "pl1", by_agent: "david", created_at: ago(35) },
        { id: 902, kind: "comment_added", ticket_id: 3898, hashid: "c2", by_agent: "david", body: "mind the Stop hook", created_at: ago(30) },
    ]), null, PINGS_YAML);
    assert.equal(res.holdUntilMs, undefined);
    assert.match(res.phrase, /2 updates:/);
    assert.match(res.phrase, /plan ACCEPTED \(#pl1\) by david/);
    assert.match(res.phrase, /mind the Stop hook/);
    assert.equal(res.headMessageId, 901);
    assert.deepEqual(res.extraSeenIds, [902]);
});

test("a wake asked by hand does not wait", async () => {
    const res = await buildContextPhrase(client([
        { id: 901, kind: "plan_accepted", ticket_id: 3898, hashid: "pl1", by_agent: "david", created_at: ago(5) },
    ]), null, PINGS_YAML, undefined, { noHold: true });
    assert.equal(res.holdUntilMs, undefined);
    assert.equal(res.headMessageId, 901);
    assert.match(res.phrase, /ACCEPTED/);
});
