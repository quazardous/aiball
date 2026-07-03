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
 *    than `TTL_MS` is rebuilt. So a future write path that forgets to
 *    invalidate degrades to ≤ a few seconds of staleness, never a permanent
 *    stale inbox. Bounded, self-healing.
 */
import { listMessages } from "./messages.js";
import type { Message } from "./connection.js";
import { parseMeta } from "../questions.js";

export interface InboxAgg {
    commentCount: number;
    pendingCount: number;
    lastActivity: string;
    closed: boolean;
    resolved: boolean;
    blocked: boolean;
    pendingResolution: boolean;
    latestResolutionId: number;
    latestResolutionRejected: boolean;
    latestPlanId: number;
    latestPlanRejected: boolean;
    pendingPlan: boolean;
    latestEscalationId: number;
    pendingEscalation: boolean;
    lastSpeaker: string | null;
    lastSpeakerId: number;
}

export function emptyAgg(): InboxAgg {
    return {
        commentCount: 0,
        pendingCount: 0,
        lastActivity: "",
        closed: false,
        resolved: false,
        blocked: false,
        pendingResolution: false,
        latestResolutionId: 0,
        latestResolutionRejected: false,
        latestPlanId: 0,
        latestPlanRejected: false,
        pendingPlan: false,
        latestEscalationId: 0,
        pendingEscalation: false,
        lastSpeaker: null,
        lastSpeakerId: 0,
    };
}

/**
 * Pure build of the per-ticket Agg map for a project. Moved verbatim from the
 * old `/api/inbox` inline loop — the reduction is order-independent (latest-
 * wins uses max-id, counts are commutative, lastActivity uses max) except the
 * lifecycle replay which sorts by id itself.
 */
export function buildInboxAgg(project: string | undefined): Map<number, InboxAgg> {
    const otherMessages = listMessages({ project }).filter(
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
            cur.pendingResolution = true;
        }
        let syntheticResolved: Message | null = null;
        if (m.kind === "comment_added" && m.status === "approved") {
            const d = parseMeta(m.meta ?? null).decision;
            if (d?.kind === "resolution") {
                if (cur.latestResolutionId === 0 || m.id > cur.latestResolutionId) {
                    cur.latestResolutionId = m.id;
                    cur.pendingResolution = d.status === "pending";
                    cur.latestResolutionRejected = d.status === "rejected";
                }
                if (d.status === "accepted") {
                    syntheticResolved = { ...m, kind: "ticket_resolved" };
                }
            }
            if (d?.kind === "plan") {
                if (cur.latestPlanId === 0 || m.id > cur.latestPlanId) {
                    cur.latestPlanId = m.id;
                    cur.latestPlanRejected = d.status === "rejected";
                    cur.pendingPlan = d.status === "pending";
                }
            }
            if (d?.kind === "escalation") {
                if (cur.latestEscalationId === 0 || m.id > cur.latestEscalationId) {
                    cur.latestEscalationId = m.id;
                    cur.pendingEscalation = d.status === "pending";
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
// Cache
// ---------------------------------------------------------------------------

const TTL_MS = 5_000; // safety ceiling for a missed invalidation
const cache = new Map<string, { agg: Map<number, InboxAgg>; builtAtMs: number }>();
const ALL = "\0all"; // key for the no-project (cross-project) view

function keyOf(project: string | undefined): string {
    return project ?? ALL;
}

/** Cached per-project Agg map. `nowMs` injectable for tests. */
export function getInboxAgg(project: string | undefined, nowMs: number = Date.now()): Map<number, InboxAgg> {
    const key = keyOf(project);
    const hit = cache.get(key);
    if (hit && nowMs - hit.builtAtMs < TTL_MS) return hit.agg;
    const agg = buildInboxAgg(project);
    cache.set(key, { agg, builtAtMs: nowMs });
    return agg;
}

/**
 * Drop the cached Agg for a project (rebuilt on next hit). The cross-project
 * `ALL` entry is always dropped too — a write to any project changes it.
 * Call from every message write chokepoint.
 */
export function invalidateInboxAgg(project?: string | null): void {
    if (project) cache.delete(project);
    cache.delete(ALL);
    if (!project) cache.clear();
}

/** Tests — force a cold cache. */
export function resetInboxAggCacheForTests(): void {
    cache.clear();
}
