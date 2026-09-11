// #2072 — ONE builder for an inbox row, so the list and the mutations cannot
// drift apart.
//
// The row shape was assembled inline inside the `/inbox` handler. That was fine
// while only the list produced it; it stops being fine the moment a mutation
// has to return "the updated object", because the front caches inbox rows and
// patches them. Two hand-kept shapes would diverge on the first field added to
// one and not the other — silently, since a missing field just renders as
// absent.
//
// So: the maps that decorate a row are gathered once (`buildInboxRowContext`),
// and the row itself is built from them (`buildInboxRow`). The list builds a
// context for a whole page; a mutation builds one for a single id. Same code,
// same shape, by construction rather than by discipline.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Message } from "../db.js";
import {
    getTicketTokenUsage,
    tagsForMessages,
    ticketAgentLastActivity,
    ticketUnreadFlags,
} from "../db.js";
import { computeHotFocus } from "../db/work-order.js";
import { ticketIdsWithPayload } from "../db/payloads.js";
import { getInboxAgg, emptyAgg } from "../db/inbox-agg.js";
import { DECISION_GESTURES, isStepStalled, kindsByAttention, type DecisionKind } from "../ticket-transitions.js";
import { getConfig } from "../db/config-overrides.js";
import { globalConfigPath } from "../autopoll/config.js";

/**
 * True when the TICKET ITSELF carries a pending decision — `ticket_new({then})`
 * files one in the ticket's own meta, with no comment to find it on.
 *
 * `kind === null` asks "is there any pending decision here", used where only
 * the existence matters.
 *
 * Lives here rather than in tickets.ts so the row builder does not import the
 * router that imports it back.
 */
export function ticketDecision(t: { meta?: string | null }, kind: string | null): boolean {
    if (!t.meta) return false;
    try {
        const d = (JSON.parse(t.meta) as { decision?: { kind?: string; status?: string } }).decision;
        if (!d || d.status !== "pending") return false;
        return kind === null ? true : d.kind === kind;
    } catch {
        // A malformed meta must never take a row down with it.
        return false;
    }
}

const DEFAULT_HOT_WINDOW_SEC = 1200;
/** Same rationale as `ticketDecision`: moved here to keep the imports acyclic. */
export function hotWindowSec(): number {
    try {
        const raw = parseYaml(readFileSync(globalConfigPath(), "utf8")) as { hot_window_sec?: unknown };
        const v = Number(raw?.hot_window_sec);
        return Number.isFinite(v) && v > 0 ? v : DEFAULT_HOT_WINDOW_SEC;
    } catch {
        return DEFAULT_HOT_WINDOW_SEC;
    }
}

export interface InboxRowContext {
    byTicket: ReturnType<typeof getInboxAgg>;
    tagsMap: ReturnType<typeof tagsForMessages>;
    unreadMap: ReturnType<typeof ticketUnreadFlags>;
    tokenUsageMap: ReturnType<typeof getTicketTokenUsage>;
    crossAgentHotFocus: ReturnType<typeof computeHotFocus>;
    /** #2112 — the tickets carrying a payload. One tiny query for the whole
     *  set, so a row can show the mark without asking per ticket. */
    payloadIds: Set<number>;
    nowStr: string;
    /** #2308 — hours after which a step nothing followed is flagged; 0 = never.
     *  Optional so a context built by hand in a test still works: absent, no
     *  row is flagged. */
    stepStaleHours?: (project: string) => number;
}

/** #2308 — `tickets.step_stale_hours`, read once per project for a whole page of rows. */
function stepStaleHoursByProject(): (project: string) => number {
    const byProject = new Map<string, number>();
    return (project) => {
        let hours = byProject.get(project);
        if (hours === undefined) {
            hours = Number(getConfig("tickets.step_stale_hours", project));
            if (!Number.isFinite(hours)) hours = 0;
            byProject.set(project, hours);
        }
        return hours;
    };
}

/**
 * Gather everything a row needs. `project` narrows the memoized aggregate; pass
 * it when the caller already knows the scope, omit it for a single ticket.
 */
export function buildInboxRowContext(
    tickets: Message[],
    consumerId: string,
    project?: string,
): InboxRowContext {
    const ids = tickets.map((m) => m.id);
    return {
        byTicket: getInboxAgg(project),
        tagsMap: tagsForMessages(ids),
        payloadIds: ticketIdsWithPayload(),
        unreadMap: ticketUnreadFlags(consumerId, ids),
        tokenUsageMap: getTicketTokenUsage(ids),
        // #2308 — read once per project, not once per row.
        stepStaleHours: stepStaleHoursByProject(),
        crossAgentHotFocus: computeHotFocus(
            ticketAgentLastActivity(ids),
            Date.now(),
            hotWindowSec() * 1000,
        ),
        nowStr: new Date().toISOString(),
    };
}

/** One inbox row, exactly as the list has always produced it. */
export function buildInboxRow(t: Message, ctx: InboxRowContext) {
    const { byTicket, tagsMap, unreadMap, tokenUsageMap, crossAgentHotFocus, payloadIds, nowStr } = ctx;
    const agg = byTicket.get(t.id) ?? emptyAgg();
    const postponedUntil = t.postponed_until ?? null;
    const postponed =
        !!postponedUntil && postponedUntil > nowStr;
    // #2308 — the decision flags follow the transition table: one rule for
    // every kind rather than a hand-kept line per kind.
    const live = !(agg.closed || t.status === "rejected");
    // #2370 — a kind's latest decision is the ticket's live one only while no
    // newer decision of any kind replaced it: the actionable gate's last-wins
    // rule, so the badge cannot disagree with the gate. A decision the ticket
    // was filed with is replaced by the first decision in its thread.
    const isLiveDecision = (kind: DecisionKind): boolean =>
        agg.decisions[kind].latestId > 0 && agg.decisions[kind].latestId === agg.latestDecisionId;
    const pendingFlag = (kind: DecisionKind): boolean =>
        ((agg.decisions[kind].pending && isLiveDecision(kind)) || (ticketDecision(t, kind) && agg.latestDecisionId === 0)) && live;
    const rejectedFlag = (kind: DecisionKind): boolean =>
        DECISION_GESTURES[kind].surfacesRejection && agg.decisions[kind].rejected && isLiveDecision(kind) && live;
    return {
        id: t.id,
        project: t.project,
        title: t.title,
        // #2071 — `summary` is NOT sent: measured at 203 KB (8.4%) of the
        // payload, and the inbox row never reads it (`titleOf` falls back
        // to a literal, not to the summary). It stays on the per-ticket
        // endpoints, where it is actually rendered.
        // #1161 S1 — list rows carry a SNIPPET, not the full body : bodies
        // were 75 % of the payload while the UI renders 140 chars max
        // (`snippetOf`). Full bodies stay on the per-ticket endpoints.
        snippet: (() => {
            const raw = (t.body ?? "").replace(/\s+/g, " ").trim();
            return raw.length > 140 ? raw.slice(0, 140) + "…" : raw || null;
        })(),
        by_agent: t.by_agent,
        created_at: t.created_at,
        status: t.status,
        intent: t.intent,
        priority: t.priority ?? "normal",
        closed: agg.closed || t.status === "rejected",
        // Same rationale as the /tickets/:id handler: resolved stays
        // true after close so the UI can distinguish "closed because
        // resolved" from "closed without explicit resolution".
        resolved: agg.resolved,
        // Agent-signalled "blocked, your call" (#B.119). Same rationale
        // as resolved: stays true after close so the UI can still show
        // *why* the ticket ended up closed.
        blocked: agg.blocked,
        // True iff there is a pending ticket_resolved on this ticket
        // that the reporter still has to accept-and-close or reject.
        // Stays false once the ticket is closed (the close auto-promotes
        // any dangling pending resolved, see submitMessage).
        pending_resolution: pendingFlag("resolution"),
        /** #B.168 follow-up: latest resolution was rejected →
            flag for a `× rejected` badge on the inbox row. Same
            suppression as pending_resolution (cleared once
            ticket is closed/rejected). */
        latest_resolution_rejected: rejectedFlag("resolution"),
        /** #B.173: same flag for plan decisions. David: reject
            plan wasn't surfaced in the list view the way reject
            resolution is. Symmetric to latest_resolution_rejected
            — cleared once the ticket is closed/rejected so the
            badge represents "live unresolved rejection". */
        latest_plan_rejected: rejectedFlag("plan"),
        /** #656 david: pending PLAN flag. Symmetric to
            pending_resolution — surfaced so the inbox row can
            show "you have a plan to accept/reject" the same way
            it shows pending resolutions. Cleared once the ticket
            is closed/rejected. */
        pending_plan: pendingFlag("plan"),
        /** #737 — pending ESCALATION flag. Symmetric to pending_plan.
            Drives the red ESCALATED badge on the inbox row. Cleared
            once the ticket is closed/rejected. */
        pending_escalation: pendingFlag("escalation"),
        /** #1835 — pending WONTFIX. The fourth decision kind, and the one
            nothing surfaced: it gates the ticket out of the agent's pool
            like a resolution does, so without this the row looked idle
            while it was in fact waiting on the reporter. */
        pending_wontfix: pendingFlag("wontfix"),
        /** #656 david `2c9qm4`: true iff a pending decision exists
            AND the decision-bearing comment IS the latest comment
            on the thread (no newer activity past the proposal).
            Drives the visual : fresh proposal = solid attention
            band, stale proposal (conversation continued past it)
            = dashed band. Null/false on rows with no pending
            decision. */
        pending_decision_is_latest: ((): boolean => {
            if (!live) return false;
            const first = kindsByAttention().find((k) => agg.decisions[k].pending && isLiveDecision(k));
            const pendingId = first ? agg.decisions[first].latestId : 0;
            if (pendingId > 0) return pendingId === agg.lastSpeakerId;
            // #1835 — a decision filed WITH the ticket (`ticket_new({then})`)
            // has no comment to compare ids against. It is the freshest
            // signal exactly while nobody has spoken since.
            return ticketDecision(t, null) && agg.commentCount === 0;
        })(),
        /** #2308 — a step (`then: continue`) nothing has followed for
            `tickets.step_stale_hours`: the work it announced went quiet. */
        /** #2327 — the ticket’s last word is a step (`then: continue`); the
            list shows a discreet blue check. */
        latest_is_step: live && agg.lastStepId > 0 && agg.lastStepId === agg.lastSpeakerId,
        stalled_step: live && isStepStalled(
            agg.lastStepAt || null,
            agg.lastStepId > 0 && agg.lastStepId === agg.lastSpeakerId,
            Date.parse(nowStr),
            ctx.stepStaleHours?.(t.project) ?? 0,
        ),
        scope: t.scope,
        // Per-consumer unread flag (≥1 unseen ping on the thread for
        // the caller, resolved from the X-Aiball-Consumer header).
        unread: unreadMap.get(t.id) ?? false,
        // #2112 — the row shows a mark only when the ticket carries a payload.
        // Absent means absent: a ticket without one is exactly the row it was.
        has_payload: payloadIds.has(t.id),
        // #405/#532 (sfbsdy + s2sjxz) + #657 david — visibility cross-
        // agent : 🔥 s'allume sur activité récente (< hot_window_sec)
        // OR claim récent (claimed_at < hot_window_sec). Le claim
        // récent est un signal fort « un agent vient de prendre
        // ça » même avant qu il poste quoi que ce soit ; le filtre
        // sur hot_window_sec évite la régression #509 (s2sjxz —
        // claim 15h vieux marquant hot indéfiniment). Le bookmark-
        // fill chip distincte dans le meta slot reste pour exposer
        // QUI claim (info que `hot` seul perd).
        hot: crossAgentHotFocus.has(t.id)
            || (typeof t.claimed_at === "string"
                && Date.now() - new Date(t.claimed_at).getTime() < hotWindowSec() * 1000),
        // Snooze (#B.329). `postponed=true` means the deadline hasn't
        // passed yet — UI hides the row from the open inbox the same
        // way `closed=true` does. `postponed_until` is the deadline
        // itself, surfaced as a chip on the row when relevant.
        postponed,
        postponed_until: postponedUntil,
        comment_count: agg.commentCount,
        pending_comment_count: agg.pendingCount,
        last_activity:
            agg.lastActivity && agg.lastActivity > t.created_at
                ? agg.lastActivity
                : t.created_at,
        // #B.132: who spoke last on this thread. Fallback to the
        // ticket creator when there are no comments yet — the
        // discrete "you spoke last" cue should still apply to
        // freshly created tickets the consumer just authored.
        last_speaker: agg.lastSpeaker ?? t.by_agent,
        tags: tagsMap.get(t.id) ?? [],
        // #427: accumulated token-effort tally (null until any usage is
        // captured) so the inbox row can surface the cost-equiv chip.
        token_usage: tokenUsageMap.get(t.id) ?? null,
        // #429: who currently holds this ticket, so the list can render a
        // compact claim/assign icon + tooltip naming the holder (parity
        // with the thread header). Two distinct holds (#436) — a row can
        // carry both: CLAIM (focus, agent self-declared) and ASSIGNMENT
        // (responsibility, a human push).
        claimant: t.claimant ?? null,
        claimed_at: t.claimed_at ?? null,
        assignee: t.assignee ?? null,
        assigned_at: t.assigned_at ?? null,
    };
}

export type InboxRow = ReturnType<typeof buildInboxRow>;
