// #3005 — what a pilot needs to read a list row at a glance, computed by the
// server so every client shares one definition: whose turn it is, which band
// the row sorts into, and the one state glyph it shows.
//
// Opt-in (`/api/inbox?view=turn`, and `sort=band` for the order): the web UI's
// list is untouched until it adopts the same row. `turn` is the actionable
// gate's own rule (`lastActorExclusions`, docs/TICKET_LIFECYCLE.md §4), read
// for the viewer, not a client-side guess from `last_speaker`: that one sees
// only comments, so it misses a decision taken or a ticket closed without a
// word, a viewer alone on a thread, and the `auto` marker.

import { inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import * as schema from "../schema.js";
import { getInboxAgg } from "../db/inbox-agg.js";
import { lastActorExclusions } from "../db/projects.js";
import { SCOPED_READ_MAX_IDS } from "../db/scope-ids.js";
import { kindsByAttention, type DecisionKind } from "../ticket-transitions.js";
import type { InboxRow } from "./inbox-row.js";

export type Turn = "you" | "them" | "none";

/** The bands, in the order `sort=band` shows them. */
export const BANDS = ["moderate", "decision", "working", "open", "closed"] as const;

export type StateGlyph =
    | "plan" | "resolution" | "wontfix" | "escalation"
    | "step" | "step_stalled" | "question" | "rejected"
    | "closed_resolved" | "closed";

export interface PilotFields {
    turn: Turn;
    /** Index into `BANDS`: `sort=band` orders by it. */
    band: number;
    /** The band's name, `BANDS[band]`: what a client reads, so a band added or removed shifts nothing for it. */
    band_name: (typeof BANDS)[number];
    state_glyph: StateGlyph | null;
}

/** What the row alone does not say, gathered per viewer. */
export interface PilotFacts {
    /** The viewer took the last action and someone else has acted: the gate's exclusion. */
    viewerActedLast: boolean;
    /** Who proposed the ticket's live pending decision, when there is one. */
    proposer: string | null;
    /** #4443 — the `handback` of the thread's last word when it is a comment that said one, else null. */
    lastHandback: boolean | null;
}

const PENDING_FLAG: Record<DecisionKind, keyof InboxRow> = {
    plan: "pending_plan",
    resolution: "pending_resolution",
    wontfix: "pending_wontfix",
    escalation: "pending_escalation",
};

function pendingKind(row: InboxRow): DecisionKind | null {
    return kindsByAttention().find((k) => row[PENDING_FLAG[k]] === true) ?? null;
}

/** Pure: the three fields from a row and the facts gathered for its viewer. */
export function pilotFields(row: InboxRow, facts: PilotFacts, viewer: string, viewerIsHuman: boolean): PilotFields {
    const pending = pendingKind(row);

    let turn: Turn;
    if (row.closed) turn = "none";
    else if (facts.viewerActedLast) turn = "them";
    // A step says "not done, I carry on", and so does a comment that kept the
    // hand (`handback: false`): the ball stays with its author.
    else if ((row.latest_is_step || facts.lastHandback === false) && row.last_speaker !== viewer) turn = "them";
    else turn = "you";

    let glyph: StateGlyph | null;
    if (row.closed) glyph = row.resolved ? "closed_resolved" : "closed";
    // A pending decision outranks a step posted after it: the decision is what gates the ticket.
    else if (pending) glyph = pending;
    else if (row.latest_is_step) glyph = row.stalled_step ? "step_stalled" : "step";
    // #4443 — the last word is a comment handing the ticket back: a question waiting on an answer.
    else if (facts.lastHandback === true) glyph = "question";
    else if (row.latest_resolution_rejected || row.latest_plan_rejected) glyph = "rejected";
    else glyph = null;

    let band: (typeof BANDS)[number];
    if (row.closed) band = "closed";
    else if (viewerIsHuman && (row.status === "pending" || row.pending_comment_count > 0)) band = "moderate";
    else if (pending && facts.proposer !== viewer) band = "decision";
    // #4446 — a question waiting on the viewer's answer waits on them like a decision.
    else if (glyph === "question" && turn === "you") band = "decision";
    else if (row.latest_is_step || (row.claimant && row.hot)) band = "working";
    else band = "open";

    return { turn, band: BANDS.indexOf(band), band_name: band, state_glyph: glyph };
}

/** What a closed row's fields never read. */
const CLOSED_FACTS: PilotFacts = { viewerActedLast: false, proposer: null, lastHandback: null };

/**
 * The facts for a page of rows, read in two bounded queries: the gate's
 * exclusion set for these ids, and the author of each live pending decision.
 */
export function buildPilotFacts(rows: readonly InboxRow[], viewer: string, project?: string): Map<number, PilotFacts> {
    const out = new Map<number, PilotFacts>();
    // #5404 — a closed row's fields do not read its facts (turn none, band and
    // glyph closed), so they are gathered for the open rows only. A `sort=band`
    // list asked them for every ticket of its filter, closed ones included: past
    // `SCOPED_READ_MAX_IDS` the gate's read scanned every message of the base.
    for (const r of rows) if (r.closed) out.set(r.id, CLOSED_FACTS);
    rows = rows.filter((r) => !r.closed);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return out;
    // #5404 — asked in bounded chunks: past `SCOPED_READ_MAX_IDS` the gate's
    // read scans every message of the base instead of these tickets'.
    const excluded = new Set<number>();
    for (let i = 0; i < ids.length; i += SCOPED_READ_MAX_IDS) {
        for (const id of lastActorExclusions(viewer, ids.slice(i, i + SCOPED_READ_MAX_IDS))) excluded.add(id);
    }
    const aggs = getInboxAgg(project);

    // A pending decision lives on a comment (its latest id in the aggregate) or,
    // when the ticket was filed with it, on the ticket itself.
    const decisionIdOf = new Map<number, number>();
    for (const r of rows) {
        const kind = pendingKind(r);
        const id = kind ? aggs.get(r.id)?.decisions[kind].latestId ?? 0 : 0;
        if (id > 0) decisionIdOf.set(r.id, id);
    }
    const authorOf = new Map<number, string>();
    const commentIds = [...decisionIdOf.values()];
    if (commentIds.length > 0) {
        for (const m of getDb().select({ id: schema.messages.id, byAgent: schema.messages.byAgent })
            .from(schema.messages).where(inArray(schema.messages.id, commentIds)).all()) {
            if (m.byAgent) authorOf.set(m.id, m.byAgent);
        }
    }

    for (const r of rows) {
        const commentId = decisionIdOf.get(r.id);
        // No comment carries it: the ticket was filed with it, by its reporter.
        const proposer = commentId ? authorOf.get(commentId) ?? null
            : pendingKind(r) ? r.by_agent : null;
        out.set(r.id, { viewerActedLast: excluded.has(r.id), proposer, lastHandback: aggs.get(r.id)?.lastSpeakerHandback ?? null });
    }
    return out;
}
