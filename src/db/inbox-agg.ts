/**
 * #1167 (S3a de #1161) — inbox aggregation cache.
 *
 * `/api/inbox` used to re-hydrate EVERY message of a project (~8k rows,
 * 70-80ms) and replay the whole history into a per-ticket Agg map on EVERY
 * hit — linear with history, paid per request, and the UI refetches on each
 * event. This module memoizes that Agg map per project.
 *
 * Correctness model:
 *  - `buildInboxAgg` is the SINGLE source of truth for the reduction (moved
 *    verbatim from the old inline loop). The cache only stores its output.
 *  - EXACT invalidation: every message write chokepoint calls
 *    `invalidateInboxAgg(project)` (append, status flip, edit, delete, decision
 *    change, move). The next hit rebuilds fresh — no incremental-update code to
 *    diverge.
 *  - SAFETY CEILING: even absent an invalidation call, a cached entry older
 *    than the store's TTL is rebuilt. So a future write path that forgets to
 *    invalidate degrades to ≤ a few seconds of staleness, never a permanent
 *    stale inbox. Bounded, self-healing.
 *
 * #2168 — the STORE itself lives in `inbox-agg-cache.ts`, a leaf that imports
 * nothing, so `projects.ts` can drop this cache on a project delete / rename /
 * purge without closing the cycle it would go through here. This module keeps
 * what an entry MEANS: the fold, and the repair.
 */
import {
    ALL_PROJECTS,
    inboxAggKey,
    getFreshInboxAgg,
    setInboxAgg,
    peekInboxAgg,
    clearInboxAgg,
} from "./inbox-agg-cache.js";
import { listMessages } from "./messages.js";
import type { Message } from "./connection.js";
import { parseMeta } from "../questions.js";
import { DECISION_KINDS, decisionGesture, isStepMeta, resolvesTicket, type DecisionKind } from "../ticket-transitions.js";

/** The latest decision of one kind on a thread. */
export interface DecisionTrack {
    latestId: number;
    pending: boolean;
    rejected: boolean;
}

export interface InboxAgg {
    commentCount: number;
    pendingCount: number;
    lastActivity: string;
    closed: boolean;
    resolved: boolean;
    blocked: boolean;
    /** #2308 — one track per decision kind, built from the transition table,
     *  so a kind added there is tracked here without a new field. A kind this
     *  aggregate did not look at is how a pending wontfix once lit nothing
     *  (#1835). */
    decisions: Record<DecisionKind, DecisionTrack>;
    lastSpeaker: string | null;
    lastSpeakerId: number;
    /** #2308 — the latest step (`then: continue`) on the thread; 0 and "" when none. */
    lastStepId: number;
    lastStepAt: string;
}

export function emptyAgg(): InboxAgg {
    return {
        commentCount: 0,
        pendingCount: 0,
        lastActivity: "",
        closed: false,
        resolved: false,
        blocked: false,
        decisions: Object.fromEntries(
            DECISION_KINDS.map((k) => [k, { latestId: 0, pending: false, rejected: false }]),
        ) as Record<DecisionKind, DecisionTrack>,
        lastSpeaker: null,
        lastSpeakerId: 0,
        lastStepId: 0,
        lastStepAt: "",
    };
}

/**
 * Pure build of the per-ticket Agg map for a project. Moved verbatim from the
 * old `/api/inbox` inline loop — the reduction is order-independent (latest-
 * wins uses max-id, counts are commutative, lastActivity uses max) except the
 * lifecycle replay which sorts by id itself.
 */
export function buildInboxAgg(project: string | undefined, ticketId?: number): Map<number, InboxAgg> {
    // #2159 — `ticketId` narrows the SOURCE ROWS, not the fold. The reduction
    // below is untouched and stays the single source of truth: repairing one
    // entry runs exactly this code over one thread's messages, so a repaired
    // entry cannot differ from a rebuilt one. That is what keeps the module's
    // "no incremental-update code to diverge" promise while dropping the cost.
    const otherMessages = listMessages({ project, ticket_id: ticketId }).filter(
        (m) => m.kind !== "ticket_created",
    );
    const byTicket = new Map<number, InboxAgg>();
    const lifecycleByTicket = new Map<number, Message[]>();
    for (const m of otherMessages) {
        if (!m.ticket_id) continue;
        const cur = byTicket.get(m.ticket_id) ?? emptyAgg();
        if (m.kind === "comment_added") {
            cur.commentCount++;
            if (m.status === "pending") cur.pendingCount++;
        }
        if (
            m.status !== "rejected" &&
            m.by_agent &&
            m.id > cur.lastSpeakerId &&
            (m.kind === "comment_added" ||
                (m.body &&
                    (m.kind === "ticket_closed" ||
                        m.kind === "ticket_reopened" ||
                        m.kind === "ticket_resolved" ||
                        m.kind === "ticket_blocked")))
        ) {
            cur.lastSpeaker = m.by_agent;
            cur.lastSpeakerId = m.id;
        }
        if (m.kind === "ticket_resolved" && m.status === "pending") {
            cur.decisions.resolution.pending = true;
        }
        // #2308 — the latest step; the row flags it once nothing has followed.
        if (m.kind === "comment_added" && m.status === "approved" && m.id > cur.lastStepId && isStepMeta(m.meta ?? null)) {
            cur.lastStepId = m.id;
            cur.lastStepAt = m.created_at;
        }
        let syntheticResolved: Message | null = null;
        if (m.kind === "comment_added" && m.status === "approved") {
            const d = parseMeta(m.meta ?? null).decision;
            // #2308 — one fold for every kind: the latest decision of a kind wins.
            if (d?.kind && decisionGesture(d.kind)) {
                const track = cur.decisions[d.kind as DecisionKind];
                if (track.latestId === 0 || m.id > track.latestId) {
                    track.latestId = m.id;
                    track.pending = d.status === "pending";
                    track.rejected = d.status === "rejected";
                }
                if (resolvesTicket(d.kind, d.status)) {
                    syntheticResolved = { ...m, kind: "ticket_resolved" };
                }
            }
        }
        if (
            (m.kind === "ticket_closed" ||
                m.kind === "ticket_reopened" ||
                m.kind === "ticket_resolved" ||
                m.kind === "ticket_blocked") &&
            m.status === "approved"
        ) {
            const list = lifecycleByTicket.get(m.ticket_id) ?? [];
            list.push(m);
            lifecycleByTicket.set(m.ticket_id, list);
        }
        if (syntheticResolved) {
            const list = lifecycleByTicket.get(m.ticket_id) ?? [];
            list.push(syntheticResolved);
            lifecycleByTicket.set(m.ticket_id, list);
        }
        if (m.created_at > cur.lastActivity) cur.lastActivity = m.created_at;
        byTicket.set(m.ticket_id, cur);
    }
    // Replay lifecycle events → final closed/resolved/blocked. Reopen resets.
    for (const [tid, events] of lifecycleByTicket) {
        events.sort((a, b) => a.id - b.id);
        const cur = byTicket.get(tid)!;
        for (const ev of events) {
            if (ev.kind === "ticket_closed") cur.closed = true;
            else if (ev.kind === "ticket_reopened") {
                cur.closed = false;
                cur.resolved = false;
                cur.blocked = false;
            } else if (ev.kind === "ticket_resolved") cur.resolved = true;
            else if (ev.kind === "ticket_blocked") cur.blocked = true;
        }
    }
    return byTicket;
}

// ---------------------------------------------------------------------------
// Cache — the store is in `inbox-agg-cache.ts`; what lives here is the fold.
// ---------------------------------------------------------------------------

/** Cached per-project Agg map. `nowMs` injectable for tests. */
export function getInboxAgg(project: string | undefined, nowMs: number = Date.now()): Map<number, InboxAgg> {
    const key = inboxAggKey(project);
    const hit = getFreshInboxAgg<Map<number, InboxAgg>>(key, nowMs);
    if (hit) return hit;
    const agg = buildInboxAgg(project);
    setInboxAgg(key, agg, nowMs);
    return agg;
}

/**
 * Drop the cached Agg for a project (rebuilt on next hit). The cross-project
 * `ALL` entry is always dropped too — a write to any project changes it.
 * Call from every message write chokepoint.
 *
 * #2159 — pass `ticketId` and the cached maps are REPAIRED instead of dropped.
 * Every field of an entry folds from its own ticket's messages (verified across
 * the whole reduction, lifecycle replay included), so a write moves exactly one
 * entry and the others are still correct. Measured: dropping them cost 184 ms
 * of rebuild on the next read, for one changed row.
 *
 * The repair RECOMPUTES the entry from scratch rather than applying a delta —
 * same fold, fewer rows — so there is no incremental state to drift. A key that
 * isn't cached is left alone: nothing to repair, and seeding a partial map from
 * one ticket would be worse than a cold rebuild.
 */
export function invalidateInboxAgg(project?: string | null, ticketId?: number): void {
    if (project && ticketId !== undefined) {
        const fresh = buildInboxAgg(project, ticketId).get(ticketId);
        // Both maps hold this ticket, and the entry is identical in each: the
        // fold reads only the thread's own messages, which belong to one
        // project. Repairing just the project map would leave the cross-project
        // view stale until the TTL — a wrong count, silently, for 5 s.
        for (const key of [project, ALL_PROJECTS]) {
            const agg = peekInboxAgg<Map<number, InboxAgg>>(key);
            if (!agg) continue;
            // No entry means the thread has no non-`ticket_created` message
            // left (its last comment was deleted); mirror the full rebuild,
            // which would not carry the ticket at all.
            if (fresh) agg.set(ticketId, fresh);
            else agg.delete(ticketId);
        }
        return;
    }
    clearInboxAgg(project);
}

/** Tests — force a cold cache. */
export function resetInboxAggCacheForTests(): void {
    clearInboxAgg();
}
