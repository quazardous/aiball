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

// #1350 — the "(fyi — action is not mandatory)" marker on EVENT wakes fires on
// the `actionable && !claimable` case only : the consumer is in the loop (ball
// in their court) but can't act because they don't own the project. A closed /
// tier-2 / tier-3 ticket is non-claimable too but is still the recipient's own
// responsibility → NO marker (david `9sxan3` : #1355 closed must NOT be fyi).
// The marker lives INSIDE the ref paren (comment) or as a single suffix paren
// (lifecycle / decision / bundle) — never a free prefix (david `ysufez`).
// Applies to comment / lifecycle / decision / bundle ; never to a claimable
// head, never to a non-actionable head, never to the backlog Triage CTA.
const FYI = /fyi — action is not mandatory/;

test("#1350 comment event on an actionable NON-claimable ticket → fyi folded into the ref paren", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [{ id: 501, kind: "comment_added", ticket_id: 920, hashid: "qctwhw", body: "style not correct" }],
            }),
            getTicket: async () => ({ ticket: { title: "watched ticket", actionable: true, claimable: false } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /style not correct/);
    assert.match(res.phrase, /#920/);
    assert.match(res.phrase, FYI);
    // #1350 (david `ysufez`) — the marker lives INSIDE the ref parenthesis, a
    // single paren `(fyi — action is not mandatory · #920 / #qctwhw)`, NOT a
    // free prefix that reads as a duplicated parenthesis.
    assert.match(
        res.phrase,
        /\(fyi — action is not mandatory · #920 \/ #qctwhw\)/,
        `fyi marker must fold into the ref paren: ${JSON.stringify(res.phrase)}`,
    );
    // The marker comes AFTER the body now (folded into the trailing ref).
    assert.ok(
        res.phrase.search(FYI) > res.phrase.indexOf("style not correct"),
        `folded marker trails the body: ${JSON.stringify(res.phrase)}`,
    );
    assert.doesNotMatch(res.phrase, /Triage the ticket/);
});

test("#1350 comment event on a CLAIMABLE ticket → NO fyi marker", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [{ id: 502, kind: "comment_added", ticket_id: 920, hashid: "qctwhw", body: "please look at this" }],
            }),
            getTicket: async () => ({ ticket: { title: "my ticket", actionable: true, claimable: true } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /please look at this/);
    assert.doesNotMatch(res.phrase, FYI);
});

// #1350 david `9sxan3` — a comment on a NON-actionable ticket (e.g. #1355 just
// closed → actionable=false, so claimable=false too) is the recipient's own
// responsibility, NOT a watcher wake : it must render as a plain wake, no marker.
test("#1350 comment event on a NON-actionable ticket (closed / tier-2/3) → NO fyi marker", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [{ id: 505, kind: "comment_added", ticket_id: 920, hashid: "qctwhw", body: "look at runic" }],
            }),
            getTicket: async () => ({ ticket: { title: "my closed ticket", actionable: false, claimable: false } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /look at runic/);
    assert.match(res.phrase, /#920/);
    assert.doesNotMatch(res.phrase, FYI);
});

test("#1350 lifecycle (reopened) event on an actionable NON-claimable ticket → fyi suffix", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [{ id: 503, kind: "ticket_reopened", ticket_id: 920 }],
            }),
            getTicket: async () => ({ ticket: { title: "watched ticket", actionable: true, claimable: false } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /reopened/i);
    assert.match(res.phrase, /#920/);
    assert.match(res.phrase, FYI);
});

test("#1350 decision-event (resolution_rejected) on an actionable NON-claimable ticket → fyi suffix", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 1 }),
            unread: async () => ({
                messages: [{ id: 504, kind: "resolution_rejected", ticket_id: 920, by_agent: "david", parent_message_id: 480 }],
            }),
            getTicket: async () => ({ ticket: { title: "watched ticket", actionable: true, claimable: false } }),
            getMessage: async () => ({ hashid: "abc123" }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /REJECT/);
    assert.match(res.phrase, /#920/);
    assert.match(res.phrase, FYI);
});

test("#1350 backlog Triage CTA never carries the fyi suffix", async () => {
    const res = await buildContextPhrase(stubClient(), null, PINGS_YAML);
    assert.match(res.phrase, /look #977/);
    assert.doesNotMatch(res.phrase, FYI);
});

// #1351 — same-ticket bundle: ≥2 unread events on the head's ticket are
// delivered as ONE wake (compact refs, newest on top / oldest at the bottom),
// and the folded-in events are marked seen via extraSeenIds.
test("#1351 ≥2 events on the SAME ticket → one bundle, newest on top / oldest at bottom", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 3 }),
            unread: async () => ({
                messages: [
                    { id: 601, kind: "comment_added", ticket_id: 920, hashid: "aaa111", body: "oldest body" },
                    { id: 602, kind: "ticket_reopened", ticket_id: 920, hashid: "bbb222" },
                    { id: 603, kind: "resolution_rejected", ticket_id: 920, hashid: "ccc333", by_agent: "david" },
                ],
            }),
            getTicket: async () => ({ ticket: { title: "shared ticket", claimable: true } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /#920: shared ticket — 3 updates:/);
    assert.match(res.phrase, /resolution REJECT \(#ccc333\) by david/);
    assert.match(res.phrase, /reopened \(#bbb222\)/);
    // #1351 david `36phxd` — a comment line carries its body (same content as a
    // standalone comment wake), not the bare "comment" label.
    assert.match(res.phrase, /oldest body \(#aaa111\)/);
    // newest (603) on top, oldest (601) at the bottom
    assert.ok(
        res.phrase.indexOf("resolution REJECT") < res.phrase.indexOf("oldest body (#aaa111)"),
        "newest event must render above the oldest",
    );
    // lifecycle / decision lines keep their descriptive label (no body).
    assert.doesNotMatch(res.phrase, /comment \(#aaa111\)/);
    // head (601) stays the inject-time prune target; 602/603 are the extras
    assert.equal(res.headMessageId, 601);
    assert.deepEqual([...(res.extraSeenIds ?? [])].sort((a, b) => a - b), [602, 603]);
    assert.equal(res.hasContent, true);
});

test("#1351 david `36phxd`: a long markdown comment body is stripped + truncated in its bundle line", async () => {
    const longBody = "**bold intro** " + "lorem ipsum dolor sit amet ".repeat(20); // >240 chars
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 2 }),
            unread: async () => ({
                messages: [
                    { id: 611, kind: "comment_added", ticket_id: 920, hashid: "aaa", body: longBody, by_agent: "david" },
                    { id: 612, kind: "comment_added", ticket_id: 920, hashid: "bbb", body: "short one", by_agent: "david" },
                ],
            }),
            getTicket: async () => ({ ticket: { title: "t", claimable: true } }),
        }),
        null,
        PINGS_YAML,
    );
    // markdown stripped (no `**`), truncated with the ellipsis stripMarkdown uses.
    assert.doesNotMatch(res.phrase, /\*\*/);
    assert.match(res.phrase, /…/);
    // the short second comment renders its body in full + its ref.
    assert.match(res.phrase, /short one \(#bbb\) by david/);
});

test("#1351 events on DIFFERENT tickets → no bundle, head renders single", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 2 }),
            unread: async () => ({
                messages: [
                    { id: 701, kind: "comment_added", ticket_id: 920, hashid: "aaa", body: "on 920" },
                    { id: 702, kind: "comment_added", ticket_id: 921, hashid: "bbb", body: "on 921" },
                ],
            }),
            getTicket: async () => ({ ticket: { title: "t920", claimable: true } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /on 920/);
    assert.doesNotMatch(res.phrase, /updates:/);
    assert.doesNotMatch(res.phrase, /on 921/);
    assert.deepEqual(res.extraSeenIds ?? [], []);
});

test("#1351 revives #1163: ≥2 decision events on one ticket → bundled, not one turn each", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 2 }),
            unread: async () => ({
                messages: [
                    { id: 801, kind: "plan_accepted", ticket_id: 920, hashid: "p1", by_agent: "david" },
                    { id: 802, kind: "resolution_accepted", ticket_id: 920, hashid: "p2", by_agent: "david" },
                ],
            }),
            getTicket: async () => ({ ticket: { title: "decided", claimable: true } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /2 updates:/);
    assert.match(res.phrase, /plan ACCEPTED \(#p1\) by david/);
    assert.match(res.phrase, /resolution ACCEPTED \(#p2\) by david/);
    assert.deepEqual(res.extraSeenIds ?? [], [802]);
});

test("#1351 bundle on an actionable NON-claimable ticket carries the #1350 fyi suffix", async () => {
    const res = await buildContextPhrase(
        stubClient({
            pingsCount: async () => ({ unread: 2 }),
            unread: async () => ({
                messages: [
                    { id: 901, kind: "comment_added", ticket_id: 920, hashid: "aaa", body: "b1" },
                    { id: 902, kind: "comment_added", ticket_id: 920, hashid: "bbb", body: "b2" },
                ],
            }),
            getTicket: async () => ({ ticket: { title: "watched", actionable: true, claimable: false } }),
        }),
        null,
        PINGS_YAML,
    );
    assert.match(res.phrase, /2 updates:/);
    assert.match(res.phrase, FYI);
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
