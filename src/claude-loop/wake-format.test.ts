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
