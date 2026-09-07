// #2042 — david's rule, in his words: "je réponds que si j'apporte un élément
// nouveau (si c'est juste pour dire tu as raison ou je suis d'accord pas la
// peine)". Agreement between two agents costs a turn on both sides and adds
// nothing, so the wake says so — but only when the event actually came from an
// agent.
//
// What these guard is mostly the NEGATIVE side. The clause is appended to every
// inter-agent wake, so getting "is this an agent?" wrong pollutes every wake
// from david, and an older daemon that cannot answer must leave them untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPhrase } from "./state.js";
import type { AiballClient } from "../client.js";

const PINGS_YAML = new URL("../../config/defaults/claude-loop-pings.yaml", import.meta.url).pathname;
const CLAUSE = /another agent wrote this — reply only if you add something new/;

/** One unread comment, with whatever the daemon said about its author. */
function clientWithHead(author: Record<string, unknown>): AiballClient {
    return {
        agentId: "claude-test",
        pingsCount: async () => ({ unread: 0 }),
        listProjectsDetailed: async () => [{ name: "aiball", open_count: 3, actionable_count: 1 }],
        unread: async () => ({
            messages: [{
                id: 501,
                kind: "comment_added",
                ticket_id: 920,
                hashid: "qctwhw",
                body: "the shape looks right to me",
                ...author,
            }],
        }),
        getConsumer: async () => null,
        listTickets: async () => [{ id: 977, title: "backlog ticket" }],
        getTicket: async () => ({ ticket: { title: "watched ticket", actionable: true, claimable: true } }),
        getProjectStandingPrompt: async () => null,
    } as unknown as AiballClient;
}

test("an event from another agent carries the restraint clause", async () => {
    const res = await buildContextPhrase(
        clientWithHead({ by_agent: "jobbox-claude", author_is_human: false }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, CLAUSE);
    // …without swallowing the event itself.
    assert.match(res.phrase, /the shape looks right to me/);
    assert.match(res.phrase, /#920/);
});

test("an event from a human does not", async () => {
    // The reason for the whole feature is that a human's ping is different in
    // kind: it is not peer chatter, and telling the agent to hold back on it
    // would be the opposite of what david asked for.
    const res = await buildContextPhrase(
        clientWithHead({ by_agent: "david", author_is_human: true }),
        null,
        PINGS_YAML,
    );
    assert.doesNotMatch(res.phrase, CLAUSE);
});

test("a daemon that doesn't say is treated as 'not an agent'", async () => {
    // The field is new. An older daemon omits it, and "unknown" must not be
    // read as "from an agent" — that would rewrite every wake in the fleet,
    // david's included.
    //
    // Asserted as absence rather than as an identical string: `{culture}` is a
    // randomly picked line, so two renders of the same wake are deliberately
    // not equal, and pinning them would be testing the stub's luck.
    const older = await buildContextPhrase(clientWithHead({ by_agent: "someone" }), null, PINGS_YAML);
    assert.doesNotMatch(older.phrase, CLAUSE);
    assert.match(older.phrase, /the shape looks right to me/, "the event still renders");
});

test("backlog wakes never carry it — there is no event to have an author", async () => {
    const res = await buildContextPhrase(
        {
            agentId: "claude-test",
            pingsCount: async () => ({ unread: 0 }),
            listProjectsDetailed: async () => [{ name: "aiball", open_count: 3, actionable_count: 1 }],
            unread: async () => ({ messages: [] }),
            getConsumer: async () => null,
            listTickets: async () => [{ id: 977, title: "backlog ticket" }],
            getTicket: async () => ({ ticket: { title: "backlog ticket", actionable: true, claimable: true } }),
            getProjectStandingPrompt: async () => null,
        } as unknown as AiballClient,
        null,
        PINGS_YAML,
    );
    assert.doesNotMatch(res.phrase, CLAUSE);
});
