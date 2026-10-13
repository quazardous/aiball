// A comment that arrives while its ticket's events wait (a plan accept held in
// its grace) is in the same-ticket bundle AND in the live notification's hint.
// The bundle lists it; the hint grafted it again in front: mcu got david's
// comment twice in one wake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPhrase } from "./state.js";
import type { AiballClient } from "../client.js";

const PINGS_YAML = new URL("../../config/defaults/claude-loop-pings.yaml", import.meta.url).pathname;
const BODY = "it should adapt to other CPUs";

function client(): AiballClient {
    const messages = [
        { id: 7001, kind: "plan_accepted", ticket_id: 4012, hashid: "ks9qnc", by_agent: "david", author_is_human: true, created_at: "2020-01-01T00:00:00Z" },
        { id: 7002, kind: "comment_added", ticket_id: 4012, hashid: "jx69wx", body: BODY, by_agent: "david", author_is_human: true },
    ];
    return {
        agentId: "claude-test",
        pingsCount: async () => ({ unread: messages.length }),
        listProjectsDetailed: async () => [{ name: "aiball", open_count: 3, actionable_count: 1 }],
        unread: async () => ({ messages }),
        getConsumer: async () => null,
        listTickets: async () => [],
        getTicket: async () => ({ ticket: { title: "A power selector", actionable: true, claimable: true } }),
        getProjectStandingPrompt: async () => null,
    } as unknown as AiballClient;
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

test("a hint on the bundled ticket is not rendered a second time", async () => {
    const res = await buildContextPhrase(client(), null, PINGS_YAML, {
        ticketId: 4012, commentId: 7002, commentHashid: "jx69wx", commentBody: BODY, commentKind: "comment_added",
    });
    assert.match(res.phrase, /2 updates:/);
    assert.equal(count(res.phrase, BODY), 1, res.phrase);
    // The bundle is what was shown, so it is what gets acked.
    assert.equal(res.headMessageId, 7001);
    assert.deepEqual(res.extraSeenIds, [7002]);
});

test("a hint on another ticket still anchors the wake on its own event", async () => {
    const res = await buildContextPhrase(client(), null, PINGS_YAML, {
        ticketId: 5000, commentId: 9001, commentHashid: "zzzzzz", commentBody: "elsewhere", commentKind: "comment_added",
    });
    assert.match(res.phrase, /elsewhere/);
    assert.doesNotMatch(res.phrase, /2 updates:/);
    assert.equal(res.headMessageId, 9001);
});
