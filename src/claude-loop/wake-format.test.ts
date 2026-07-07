// #999 — the wake FORMAT is routed by its TRIGGER, not by a re-derived head :
//   - an EVENT wake (SSE ping → `buildContextPhrase` gets a `WakeEventHint`)
//     renders the COMMENT-centric branch (body + ref), anchored on the hint,
//     even when the FIFO already pruned/raced past that ping.
//   - a heartbeat / drain wake (no hint) may fall to the BACKLOG ticket-centric
//     "look #N… Triage" branch when the FIFO is empty.
//
// The regression these guard : a human comment used to surface as a backlog
// "Triage" prompt because the event hint was thrown away and the empty FIFO
// fell through to `backlogMode`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPhrase } from "./state.js";
import type { AiballClient } from "../client.js";

const PINGS_YAML = new URL(
    "../../config/defaults/claude-loop-pings.yaml",
    import.meta.url,
).pathname;

// Minimal stub : FIFO empty, one open ticket available as backlog head.
// Each scenario tweaks only what it needs.
function stubClient(over: Partial<Record<string, unknown>> = {}): AiballClient {
    const base: Record<string, unknown> = {
        agentId: "claude-test",
        pingsCount: async () => ({ unread: 0 }),
        listProjectsDetailed: async () => [
            { name: "aiball", open_count: 3, actionable_count: 1 },
        ],
        // FIFO head — empty by default (the racy case that fell to backlog).
        unread: async () => ({ messages: [] }),
        getConsumer: async () => null,
        // backlog head when the FIFO is empty.
        listTickets: async () => [{ id: 977, title: "backlog ticket" }],
        getTicket: async () => ({ ticket: { title: "Parent ticket title" } }),
        ...over,
    };
    return base as unknown as AiballClient;
}

test("#999 event wake (hint, empty FIFO) → comment-centric, never backlog Triage", async () => {
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML, {
        ticketId: 920,
        commentHashid: "qctwhw",
        commentBody: "focus on the prompt format",
    });
    // comment-centric : body + (#ticket / #comment_hashid)
    assert.match(res.phrase, /focus on the prompt format/);
    assert.match(res.phrase, /#920/);
    assert.match(res.phrase, /qctwhw/);
    // NOT the backlog ticket-centric branch
    assert.doesNotMatch(res.phrase, /Triage the ticket/);
    assert.doesNotMatch(res.phrase, /#977/);
    assert.equal(res.backlogTicketId, null);
    assert.equal(res.hasContent, true);
});

test("#999 heartbeat wake (no hint, empty FIFO) → backlog ticket-centric Triage", async () => {
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML);
    // ticket-centric "look #N … Triage" (wording may be localized by the
    // project's .aiball.yaml override — match the language-agnostic shape).
    assert.match(res.phrase, /look #977/);
    assert.match(res.phrase, /Triage/i);
    assert.equal(res.backlogTicketId, 977);
    assert.equal(res.hasContent, true);
});

test("#1215 backlog head with last_actor ≠ me → names who's waiting, no (state clock", async () => {
    const res = await buildContextPhrase(
        stubClient({ listTickets: async () => [{ id: 977, title: "backlog ticket", last_actor: "david" }] }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /look #977/);
    assert.match(res.phrase, /david is waiting on your reply/);
    // the useless HH:MM clock is gone (#1215)
    assert.doesNotMatch(res.phrase, /\(state /);
});

test("#1215 backlog head with no last_actor → plain look, no waiting clause", async () => {
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML);
    assert.match(res.phrase, /look #977/);
    assert.doesNotMatch(res.phrase, /is waiting on your reply/);
    assert.doesNotMatch(res.phrase, /\(state /);
});

test("#999 event wake with FIFO already carrying the comment → still comment-centric", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [
                    {
                        id: 555,
                        kind: "comment_added",
                        ticket_id: 920,
                        hashid: "qctwhw",
                        body: "fifo body wins",
                    },
                ],
            }),
        }),
        null,
        PINGS_YAML,
        { ticketId: 920, commentHashid: "qctwhw", commentBody: "hint body" },
    );
    // FIFO head is authoritative when present (fresher) — anchor is a no-op.
    assert.match(res.phrase, /fifo body wins/);
    assert.match(res.phrase, /#920/);
    assert.doesNotMatch(res.phrase, /Triage the ticket/);
});

// #1169 — un decision-event (body vide) arrivé par HINT alors que le FIFO ne
// l'a pas comme head ne doit PAS se rendre en refs nues « (#N / #hashid) ».
// Le hint porte maintenant `commentKind` ; la branche comment-centrique est
// désactivée pour un decision-event → skip propre (l'event ressurgit via FIFO).
test("#1169 hint decision-event (empty FIFO) → PAS de refs nues, tombe sur backlog", async () => {
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML, {
        ticketId: 1166,
        commentHashid: "48c3kp",
        commentBody: "", // decision-event = body vide
        commentKind: "resolution_accepted",
    });
    // surtout PAS « (#1166 / #48c3kp) » nu
    assert.doesNotMatch(res.phrase, /#48c3kp/, `refs nues rendues : ${JSON.stringify(res.phrase)}`);
    // le FIFO étant vide, on retombe sur la branche backlog (comportement sain)
    // — l'important est l'absence de la ref-comment nue.
});

test("#1169 hint comment_added réel (empty FIFO) → toujours comment-centric", async () => {
    // garde-fou anti-régression : un vrai comment continue de rendre body+ref.
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML, {
        ticketId: 920,
        commentHashid: "qctwhw",
        commentBody: "real comment body",
        commentKind: "comment_added",
    });
    assert.match(res.phrase, /real comment body/);
    assert.match(res.phrase, /qctwhw/);
});
