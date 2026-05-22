/**
 * Ticket-domain routes (carved out of api.ts in #B.213 phase 1.G on
 * 2026-05-19). Behavior-preserving move.
 *
 * Endpoints:
 *   GET   /tickets/bookends                  — slim inbox edges (#B.68)
 *   GET   /inbox                             — unified inbox view
 *   GET   /tickets                           — list with filters (#B.83/87)
 *   POST  /tickets/:id/mark-read             — per-consumer ack (#B.191)
 *   POST  /tickets/:id/mark-unread
 *   PATCH /tickets/:id                       — broadcast toggle
 *   POST  /tickets/:id/postpone              — snooze (#B.329)
 *   POST  /tickets/:id/unsnooze
 *   GET   /tickets/:id/relations             — typed relations (#B.123 phase B)
 *   POST  /tickets/:id/relations
 *   GET   /tickets/:id                       — header / brief / digest / full
 *
 * Local helper `enrichRelationStages` is kept private — only the GET
 * /tickets/:id thread builder uses it.
 */
import { Router, type Request, type Response } from "express";
import {
    listMessages,
    listMessageTags,
    tagsForMessages,
    resolveAttachments,
    type Message,
    type MessageStatus,
    setTicketPostpone,
    listSubTickets,
    subTicketCounts,
    getTicketStages,
    getTicketBookends,
    getMessage,
    getMessageByHashid,
    markTicketSeen,
    markTicketUnseen,
    ticketUnreadFlags,
    isHuman,
    insertTypedRelation,
    listTypedRelationsForTicket,
    lineageWouldCycle,
    setTicketOwner,
    upsertTicketSubscription,
} from "../db.js";
import { computeActionableTicketIds } from "../db/projects.js";
import { RELATION_KINDS, isRelationKind, isLineageRelationKind, type RelationKind } from "../relations.js";
import { broadcast } from "../ws.js";
import { parseMeta } from "../questions.js";
import { badRequest, consumerOf, notFound, withTags } from "./_helpers.js";
import { moveTicketTo } from "../messages.js";

export const ticketsRouter = Router();

/**
 * #352: change a ticket's owner (= its `by_agent` / reporter — no model
 * change). Human-moderator only. Subscribes the new owner so they get the
 * thread's pings; owner-bypass (close/reopen) follows `by_agent`.
 */
ticketsRouter.post("/tickets/:id/owner", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!isHuman(consumerOf(req))) {
        return res.status(403).json({ error: "owner change is moderator-only" });
    }
    const by_agent = typeof req.body?.by_agent === "string" ? req.body.by_agent.trim() : "";
    if (!by_agent) return badRequest(res, "by_agent required (non-empty string)");
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    setTicketOwner(id, by_agent);
    upsertTicketSubscription(by_agent, id);
    res.json({ ticket_id: id, by_agent });
});

/**
 * Inbox bookends: oldest + newest non-rejected ticket matching the
 * scope. Used by the slim `poll()` (per #B.68) so agents see the
 * inbox edges without paying for the full subscriptions/projects blob.
 *
 * Query:
 *   - project=NAME    (optional) restrict to a project; otherwise cross-project.
 *   - include_snoozed=1  include snoozed tickets in the scope.
 */
ticketsRouter.get("/tickets/bookends", (req, res) => {
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const includeSnoozed = req.query.include_snoozed === "1";
    res.json(getTicketBookends({ project, includeSnoozed }));
});

/**
 * Unified inbox view: one row per ticket, decorated with the latest activity
 * timestamp (so a new pending comment bumps its parent ticket to the top) and
 * with pending-comment counts so the moderator sees at a glance what needs
 * attention. Filter by status:
 *   - "pending"  → tickets that are themselves pending OR have ≥1 pending comment
 *   - "approved" → tickets with status=approved
 *   - "rejected" → tickets with status=rejected
 *   - undefined  → every ticket regardless of status
 */
ticketsRouter.get("/inbox", (req, res) => {
    const project = req.query.project as string | undefined;
    const status = req.query.status as MessageStatus | undefined;
    const onlyOpen = req.query.open === "1";
    const intentFilter = req.query.intent as string | undefined;
    // #B.222: optional priority filter — accepts a single value (low /
    // normal / high / urgent) and narrows the list to tickets whose
    // priority matches. "all" or absent = no filter.
    const priorityFilter = req.query.priority as string | undefined;
    // Include snoozed tickets in the open-inbox view (per #B.329). The
    // toggle in the header flips this on so a moderator can see what's
    // currently set aside. Default off — snoozed rows are hidden the
    // same way closed ones are.
    const includePostponed = req.query.include_postponed === "1";
    // Read state is per-consumer — resolved from the X-Aiball-Consumer
    // header (UI sets this once globally) with AIBALL_HUMAN fallback.
    // Each row gets an `unread` boolean computed from the pings table
    // (≥1 unseen ping on the thread for that consumer).
    const consumerId = consumerOf(req);

    const tickets = listMessages({ kind: "ticket_created", project });
    const otherMessages = listMessages({ project }).filter(
        (m) => m.kind !== "ticket_created",
    );

    interface Agg {
        commentCount: number;
        pendingCount: number;
        lastActivity: string;
        // Walk all approved lifecycle events in id order to derive the
        // current closed/resolved flags. Order matters because reopen
        // resets resolved.
        closed: boolean;
        resolved: boolean;
        // Agent explicitly flagged "I can't proceed, human take over"
        // (#B.119). Independent of resolved — they signal different
        // intents to the reporter.
        blocked: boolean;
        // Surface pending ticket_resolved proposals so the reporter sees
        // in the list view that a thread is awaiting their accept/reject.
        // Only counts non-stale ones (we ignore them once the ticket is
        // closed since closing implicitly clears them).
        pendingResolution: boolean;
        // #B.168: latest comment id carrying a resolution decision —
        // used to honor "latest wins" when multiple resolution
        // comments coexist on the same thread.
        latestResolutionId: number;
        /** #B.168 follow-up: surface in the inbox row when the LAST
            resolution decision was rejected (so the reporter sees
            "yes I rejected it, the thread is open"). */
        latestResolutionRejected: boolean;
        // #B.173: same mechanic for plan decisions. David: "reject
        // plan est pas flag dans les list comme reject resolution".
        // Latest-wins symmetric with resolution.
        latestPlanId: number;
        latestPlanRejected: boolean;
        // #B.132: who spoke last on this thread. Tracks the by_agent
        // of the most recent non-rejected approved comment_added.
        // Falls back to the ticket creator if no comments yet.
        lastSpeaker: string | null;
        lastSpeakerId: number;
    }
    const byTicket = new Map<number, Agg>();
    // Sort lifecycle events for each ticket by id ASC so we can replay
    // them in order. Comments are tallied independently.
    const lifecycleByTicket = new Map<number, Message[]>();
    for (const m of otherMessages) {
        if (!m.ticket_id) continue;
        const cur =
            byTicket.get(m.ticket_id) ??
            ({
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
                lastSpeaker: null,
                lastSpeakerId: 0,
            } as Agg);
        if (m.kind === "comment_added") {
            cur.commentCount++;
            if (m.status === "pending") cur.pendingCount++;
        }
        // #B.132: track who spoke last on this thread. Counts any
        // non-rejected message carrying content the human would read.
        // - `comment_added`: always (any status — even pending mod is
        //   "the author spoke, just not yet visible publicly").
        // - lifecycle events (`ticket_closed`/`reopened`/`resolved`/
        //   `blocked`): count when they carry a non-empty body (an
        //   explanation typed in the composer). Bare close/reopen
        //   with no body excluded — that's not speech.
        // System-only relations (`ticket_referenced` / `ticket_sub_added`)
        // never count.
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
        // #B.129 phase 2: a comment carrying `meta.decision.kind ===
        // "resolution"` plays the same role as the legacy
        // ticket_resolved event. Latest-wins semantics (#B.168):
        // pending_resolution reflects whether the MOST RECENT
        // resolution-decision comment is still pending — older
        // pending proposals that the agent re-framed over time
        // shouldn't keep the flag stuck after the reporter rejected
        // the active one. otherMessages is sorted DESC by id, so the
        // FIRST resolution-decision comment we see is the latest;
        // skip subsequent ones via `latestResolutionId`. accepted →
        // synthetic resolved event for the replay below.
        let syntheticResolved: Message | null = null;
        if (m.kind === "comment_added" && m.status === "approved") {
            const meta = parseMeta(m.meta ?? null);
            const d = meta.decision;
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
            // #B.173: same latest-wins for plan decisions. No
            // synthetic event — accepting a plan doesn't change the
            // ticket lifecycle (it just records "yes, that's the
            // direction"), only resolutions can close. Surface the
            // rejected state so the inbox row can flag it (parallel
            // to latest_resolution_rejected).
            if (d?.kind === "plan") {
                if (cur.latestPlanId === 0 || m.id > cur.latestPlanId) {
                    cur.latestPlanId = m.id;
                    cur.latestPlanRejected = d.status === "rejected";
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
    // Replay lifecycle events to compute final closed/resolved/blocked
    // flags. Reopen clears resolved + blocked alike (it's a "scratch
    // and restart" signal from the reporter).
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

    const tagsMap = tagsForMessages(tickets.map((m) => m.id));
    const unreadMap = ticketUnreadFlags(consumerId, tickets.map((m) => m.id));
    const nowStr = new Date().toISOString();
    let rows = tickets.map((t) => {
        const agg =
            byTicket.get(t.id) ??
            ({
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
                lastSpeaker: null,
                lastSpeakerId: 0,
            } as Agg);
        const postponedUntil = t.postponed_until ?? null;
        const postponed =
            !!postponedUntil && postponedUntil > nowStr;
        return {
            id: t.id,
            project: t.project,
            title: t.edited_title ?? t.title,
            summary: t.summary ?? null,
            body: t.edited_body ?? t.body,
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
            pending_resolution: agg.pendingResolution && !(agg.closed || t.status === "rejected"),
            /** #B.168 follow-up: latest resolution was rejected →
                flag for a `× rejected` badge on the inbox row. Same
                suppression as pending_resolution (cleared once
                ticket is closed/rejected). */
            latest_resolution_rejected: agg.latestResolutionRejected && !(agg.closed || t.status === "rejected"),
            /** #B.173: same flag for plan decisions. David: reject
                plan wasn't surfaced in the list view the way reject
                resolution is. Symmetric to latest_resolution_rejected
                — cleared once the ticket is closed/rejected so the
                badge represents "live unresolved rejection". */
            latest_plan_rejected: agg.latestPlanRejected && !(agg.closed || t.status === "rejected"),
            scope: t.scope,
            // Per-consumer unread flag (≥1 unseen ping on the thread for
            // the caller, resolved from the X-Aiball-Consumer header).
            unread: unreadMap.get(t.id) ?? false,
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
        };
    });

    if (status === "pending") {
        rows = rows.filter((r) => r.status === "pending" || r.pending_comment_count > 0);
    } else if (status === "approved" || status === "rejected") {
        rows = rows.filter((r) => r.status === status);
    }
    if (onlyOpen) {
        rows = rows.filter((r) => !r.closed);
    }
    // Snooze filter applies on every status combination — not just when
    // `open=1`. Otherwise pending+snoozed tickets slip through (regression
    // surfaced after #B.78 enabled snoozing on pending tickets).
    if (!includePostponed) {
        rows = rows.filter((r) => !r.postponed);
    }
    if (intentFilter && intentFilter !== "all") {
        rows = rows.filter((r) => r.intent === intentFilter);
    }
    if (priorityFilter && priorityFilter !== "all") {
        rows = rows.filter((r) => (r.priority ?? "normal") === priorityFilter);
    }

    rows.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

    res.json(rows);
});

ticketsRouter.get("/tickets", (req, res) => {
    const project = req.query.project as string | undefined;
    const onlyOpen = req.query.open === "1";
    // #B.232 #234 david: actionable=1 is a stricter form of open=1
    // that ALSO excludes resolved-pending, blocked, and gated tickets
    // (mirrors actionable_count semantics on the sidebar). Used by the
    // wake-CTA so the agent's candidate pool excludes tickets already
    // in awaiting-validation state. Frontend keeps open=1 for the
    // broader "everything not lifecycle-closed" view (david still needs
    // to see resolution proposals to act on them).
    const onlyActionable = req.query.actionable === "1";
    // Default: when `open=1`, snoozed tickets are hidden (same rule as
    // the inbox). Pass `include_postponed=1` to surface them anyway.
    const includePostponed = req.query.include_postponed === "1";
    // Tag filter — comma-separated names. AND semantics: a ticket must
    // carry EVERY listed tag to match. Unknown tag names are ignored
    // silently rather than 400'ing — keeps the URL lenient.
    const tagsFilter = typeof req.query.tags === "string"
        ? req.query.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    // Verbosity (#B.83 then #B.87 palier 2): default is summary now —
    // header-only payload, no body / edited_body. Pass `full=1` to
    // re-include bodies. `summary=1` kept as an accepted alias for
    // explicit-summary requests; `summary=0` forces full. The plain
    // default (neither flag) is summary.
    const fullParam = req.query.full;
    const summaryParam = req.query.summary;
    const summary =
        fullParam === "1"
            ? false
            : summaryParam === "0"
              ? false
              : true;
    // Author filter (#B.84): scope to tickets posted by a specific
    // consumer_id. Useful for "my tickets" without scanning the full list.
    const byAgent = typeof req.query.by_agent === "string" && req.query.by_agent
        ? req.query.by_agent
        : undefined;
    // Status filter (#B.84): default "approved" preserves prior behavior;
    // pass "pending" / "rejected" / "any" to widen.
    const statusParam = (req.query.status as string | undefined) ?? "approved";
    const statusFilter: "pending" | "approved" | "rejected" | undefined =
        statusParam === "pending" || statusParam === "approved" || statusParam === "rejected"
            ? statusParam
            : statusParam === "any"
              ? undefined
              : "approved";
    // Substring filter (#B.84): case-insensitive contains on the
    // (edited_)title. Cheap alternative to FTS when looking up a ticket
    // by name.
    const titleContains =
        typeof req.query.title_contains === "string" && req.query.title_contains
            ? req.query.title_contains.toLowerCase()
            : undefined;
    const limit =
        typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
            ? Math.max(1, Math.min(500, Number(req.query.limit)))
            : undefined;
    // since (#B.87): filter on ticket created_at >= since. Accepts any
    // string Date.parse() understands (ISO8601 recommended). Cheap
    // alternative to client-side diff when polling for new tickets.
    const sinceParam = typeof req.query.since === "string" ? req.query.since : undefined;
    const sinceIso = sinceParam && Number.isFinite(Date.parse(sinceParam))
        ? new Date(Date.parse(sinceParam)).toISOString()
        : undefined;

    const created = listMessages({
        status: statusFilter,
        kind: "ticket_created",
        project,
        by_agent: byAgent,
    });

    const closes = listMessages({
        status: "approved",
        kind: "ticket_closed",
        project,
    });
    const closedSet = new Set(closes.map((c) => c.ticket_id));
    const nowStr = new Date().toISOString();

    const tagsMap = tagsForMessages(created.map((m) => m.id));
    const childCounts = subTicketCounts(created.map((m) => m.id));
    const tickets = created.map((m) => {
        const postponedUntil = m.postponed_until ?? null;
        const postponed = !!postponedUntil && postponedUntil > nowStr;
        const base = {
            id: m.id,
            project: m.project,
            title: m.edited_title ?? m.title,
            // Agent-authored summary (#B.87). Falls back to title when
            // unset so consumers always have something printable.
            summary: m.summary ?? null,
            by_agent: m.by_agent,
            status: m.status,
            created_at: m.created_at,
            closed: closedSet.has(m.id),
            scope: m.scope,
            postponed,
            postponed_until: postponedUntil,
            intent: m.intent,
            priority: m.priority ?? "normal",
            parent_ticket_id: m.parent_ticket_id ?? null,
            sub_ticket_count: childCounts.get(m.id) ?? 0,
            tags: tagsMap.get(m.id) ?? [],
        };
        if (summary) return base;
        return { ...base, body: m.edited_body ?? m.body };
    });

    let result = tickets;
    if (onlyOpen) {
        result = result.filter((t) => !t.closed && (includePostponed || !t.postponed));
    }
    if (onlyActionable) {
        // #265: scope the actionable gate to the requesting consumer so a
        // ticket where they authored the latest content (awaiting someone
        // else) drops out of THEIR pool.
        const { actionableIds } = computeActionableTicketIds(consumerOf(req));
        result = result.filter((t) => actionableIds.has(t.id));
    }
    if (tagsFilter && tagsFilter.length > 0) {
        const requiredSet = new Set(tagsFilter.map((s) => s.toLowerCase()));
        result = result.filter((t) => {
            const have = new Set((t.tags as { name: string }[]).map((tag) => tag.name.toLowerCase()));
            for (const need of requiredSet) if (!have.has(need)) return false;
            return true;
        });
    }
    if (titleContains) {
        result = result.filter((t) =>
            (t.title ?? "").toLowerCase().includes(titleContains),
        );
    }
    if (sinceIso) {
        result = result.filter((t) => t.created_at >= sinceIso);
    }
    // #B.222 david 68km5s: when listing the actionable/open pool —
    // i.e. the candidate set the wake-CTA or autopoll points the agent
    // at — sort by priority desc (urgent → high → normal → low), then
    // by id desc within each priority bucket. The general listing path
    // (no open/actionable filter) keeps insertion order so existing
    // browse callers aren't impacted. Priority strings normalize via
    // PRIORITY_WEIGHT; unknown values fall back to "normal" weight.
    if (onlyOpen || onlyActionable) {
        const PRIORITY_WEIGHT: Record<string, number> = {
            urgent: 4,
            high: 3,
            normal: 2,
            low: 1,
        };
        result.sort((a, b) => {
            const wA = PRIORITY_WEIGHT[a.priority ?? "normal"] ?? 2;
            const wB = PRIORITY_WEIGHT[b.priority ?? "normal"] ?? 2;
            if (wA !== wB) return wB - wA;
            return b.id - a.id;
        });
    }
    if (limit !== undefined) result = result.slice(0, limit);
    res.json(result);
});

ticketsRouter.post("/tickets/:id/mark-read", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    // Optional up_to_id bounds the ack (#B.191) — see markTicketSeen.
    const upToId = req.body?.up_to_id;
    const opts = typeof upToId === "number" && upToId > 0 ? { upTo: upToId } : undefined;
    const r = markTicketSeen(consumerOf(req), id, opts);
    res.json({ ticket_id: id, ...(opts ? { up_to_id: upToId } : {}), ...r });
});

ticketsRouter.post("/tickets/:id/mark-unread", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const r = markTicketUnseen(consumerOf(req), id);
    res.json({ ticket_id: id, ...r });
});

/**
 * Snooze a ticket (per #B.329). Body: `{ until: ISO8601 }` — the ticket
 * is hidden from the open inbox until that timestamp. The daemon's
 * reveal cron clears the field at the deadline and posts a synthetic
 * `ticket_reopened` so it bounces back.
 *
 * Owner / human-bypass is enforced: only the ticket reporter or the
 * human moderator can snooze. Other agents get a 403 to avoid surprise
 * "where did my ticket go" moments.
 */
ticketsRouter.post("/tickets/:id/postpone", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can snooze this ticket`,
        });
    }
    const { until } = (req.body ?? {}) as { until?: unknown };
    if (typeof until !== "string" || !until) {
        return badRequest(res, "until (ISO8601 string) required");
    }
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed)) {
        return badRequest(res, `invalid until "${until}" — expected ISO8601`);
    }
    if (parsed <= Date.now()) {
        return badRequest(res, "until must be in the future");
    }
    const iso = new Date(parsed).toISOString();
    const ok = setTicketPostpone(id, iso);
    if (!ok) return notFound(res, "ticket not found");
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: iso });
});

ticketsRouter.post("/tickets/:id/unsnooze", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can unsnooze this ticket`,
        });
    }
    setTicketPostpone(id, null);
    const updated = getMessage(id);
    if (updated) broadcast({ type: "message_edited", data: updated });
    res.json({ ticket_id: id, postponed_until: null });
});

/**
 * Move a ticket (whole thread) to another project (#294). Reporter-or-human
 * only — same authority as postpone/close. The project lives only on the
 * head, so the move is a head update (project + fresh display_seq) plus an
 * in-thread audit comment; broadcast lets both project views update live.
 */
ticketsRouter.post("/tickets/:id/move", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const caller = consumerOf(req);
    if (!isHuman(caller) && t.by_agent !== caller) {
        return res.status(403).json({
            error: `only the ticket reporter (${t.by_agent}) or a registered human moderator can move this ticket`,
        });
    }
    const { project } = (req.body ?? {}) as { project?: unknown };
    if (typeof project !== "string" || !project.trim()) {
        return badRequest(res, "project (non-empty string) required");
    }
    const target = project.trim();
    if (target === t.project) {
        return badRequest(res, `ticket is already in project "${target}"`);
    }
    const updated = moveTicketTo(id, target, caller);
    res.json(updated);
});

// ---- Typed inter-ticket relations (#B.123 phase B) ------------------------
//
// Append-only events: POST creates a new ticket_relation row. To change a
// kind, POST a new event with the same target; the replay (listTypedRelations
// ForTicket) keeps only the latest per target. To remove, POST kind=ignored
// — acts as a tombstone in the replay. No PATCH/DELETE endpoint; the event
// log is the source of truth.

ticketsRouter.get("/tickets/:id/relations", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    res.json({ ticket_id: id, relations: listTypedRelationsForTicket(id) });
});

ticketsRouter.post("/tickets/:id/relations", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ticket id required" });
    const t = getMessage(id);
    if (!t || t.kind !== "ticket_created") return notFound(res, "ticket not found");
    const body = (req.body ?? {}) as { target_ticket_id?: number; kind?: string };
    const target = Number(body.target_ticket_id);
    if (!Number.isFinite(target) || target <= 0) {
        return res.status(400).json({ error: "target_ticket_id required (positive integer)" });
    }
    if (target === id) {
        return res.status(400).json({ error: "a ticket cannot relate to itself" });
    }
    const kindStr = typeof body.kind === "string" ? body.kind : "";
    if (!isRelationKind(kindStr)) {
        return res.status(400).json({
            error: `kind must be one of ${RELATION_KINDS.join(", ")}`,
        });
    }
    const targetTicket = getMessage(target);
    if (!targetTicket || targetTicket.kind !== "ticket_created") {
        return res.status(404).json({ error: `target ticket #B.${target} not found` });
    }
    const caller = consumerOf(req);
    // Permission (#275): mirror the edit/snooze gate (isHuman bypass +
    // reporter), but accept the reporter of EITHER end — a relation links
    // two tickets, and standing on one of them is enough to attach the
    // other (e.g. file your own ticket as child_of someone else's). Human
    // moderators bypass entirely; the UI is human-driven, so this doesn't
    // change its behaviour.
    if (
        !isHuman(caller) &&
        t.by_agent !== caller &&
        targetTicket.by_agent !== caller
    ) {
        return res.status(403).json({
            error: `only a registered human moderator or the reporter of #B.${id} (${t.by_agent}) / #B.${target} (${targetTicket.by_agent}) can relate them`,
        });
    }
    // Anti-cycle (#275): lineage (child_of/parent_of) must stay a DAG.
    // Reject an edge that would close a loop. parent_of is the mirror of
    // child_of, so swap (child, parent) for the check.
    if (kindStr === "child_of" && lineageWouldCycle(id, target)) {
        return res.status(409).json({
            error: `#B.${id} child_of #B.${target} would create a lineage cycle`,
        });
    }
    if (kindStr === "parent_of" && lineageWouldCycle(target, id)) {
        return res.status(409).json({
            error: `#B.${id} parent_of #B.${target} would create a lineage cycle`,
        });
    }
    // Idempotency (#275): at most one active edge per (source, target).
    // Re-posting the same active kind, or removing (ignored) an edge that
    // isn't there, is a no-op — don't append a redundant event.
    const before = listTypedRelationsForTicket(id);
    if (kindStr === "ignored") {
        if (!before.some((r) => r.target_ticket_id === target)) {
            return res.json({ ticket_id: id, event_id: null, noop: true, relations: before });
        }
    } else if (before.some((r) => r.target_ticket_id === target && r.kind === kindStr)) {
        const dup = before.find((r) => r.target_ticket_id === target && r.kind === kindStr)!;
        return res.json({ ticket_id: id, event_id: dup.last_event_id, noop: true, relations: before });
    }
    const event = insertTypedRelation({
        source_ticket_id: id,
        target_ticket_id: target,
        relation_kind: kindStr as RelationKind,
        by_agent: caller,
    });
    if (!event) return res.status(500).json({ error: "failed to create relation event" });
    broadcast({ type: "message_created", data: event });
    res.json({
        ticket_id: id,
        event_id: event.id,
        relations: listTypedRelationsForTicket(id),
    });
});

ticketsRouter.get("/tickets/:id", (req, res) => {
    // The :id param accepts either:
    //   - an integer ticket id (#B<id>) → resolved directly,
    //   - an integer comment id (legacy #C<id>) → resolved to parent thread
    //     with focus_message_id set,
    //   - a 6-char hashid string (canonical #C<hashid>) → looked up by
    //     hashid then resolved like an integer comment.
    const raw = req.params.id;
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    let requested: Message | null = null;
    if (numeric !== null) {
        requested = getMessage(numeric);
    }
    if (!requested) {
        requested = getMessageByHashid(raw);
    }
    if (!requested) return notFound(res, "ticket not found");
    // If the id is a comment (or close/reopen event), resolve up to its
    // parent ticket and attach `focus_message_id` so the UI can scroll to
    // the right place. Lets `#N` references in markdown be opened blindly.
    let t = requested;
    let focusMessageId: number | null = null;
    if (t.kind !== "ticket_created") {
        if (!t.ticket_id) return notFound(res, "ticket not found");
        const parent = getMessage(t.ticket_id);
        if (!parent || parent.kind !== "ticket_created") {
            return notFound(res, "ticket not found");
        }
        focusMessageId = requested.id;
        t = parent;
    }
    const id = t.id;
    // Return tickets in any status so the moderator can open pending or
    // rejected ones from the inbox and act on them inline.
    const all = listMessages({ project: t.project });
    // Thread feed = comments + lifecycle events, inline. Lifecycle events
    // (close / reopen / resolved) are rendered as system rows in the UI so
    // the reader can see who flipped the state and when. Order: ASC by id.
    // #309: the UI opts into seeing user-deleted comments (as tombstones)
    // via ?include_deleted=1; default (and every MCP read) never sees them.
    const includeDeleted = req.query.include_deleted === "1";
    const threadMessages = all
        .filter(
            (m) =>
                m.ticket_id === id &&
                (m.kind === "comment_added" ||
                    m.kind === "ticket_closed" ||
                    m.kind === "ticket_reopened" ||
                    m.kind === "ticket_resolved" ||
                    m.kind === "ticket_blocked" ||
                    m.kind === "ticket_sub_added" ||
                    m.kind === "ticket_referenced" ||
                    m.kind === "ticket_relation") &&
                // rejected rows are hidden — EXCEPT user-deletions (#309): a
                // comment with meta.deleted is re-surfaced as a tombstone, but
                // only when the UI explicitly asks (include_deleted).
                (m.status !== "rejected" ||
                    (includeDeleted &&
                        m.kind === "comment_added" &&
                        !!parseMeta(m.meta ?? null).deleted)) &&
                // #271: lineage relations (child_of/parent_of) are surfaced
                // as chips in the relations cartouche; the ticket_sub_added
                // pseudo already logs the link in the timeline, so drop the
                // parallel relation event here to avoid a redundant row.
                !(m.kind === "ticket_relation" &&
                    isLineageRelationKind(parseMeta(m.meta ?? null).relation?.kind ?? "")),
        )
        .sort((a, b) => a.id - b.id);
    // Lifecycle replay restricted to approved events for the header
    // flags. Since #B.129 phase 2, a comment_added with `meta.decision
    // .kind=="resolution"` and decision.status=="accepted" is replayed
    // as a synthetic ticket_resolved event at the comment's id, so
    // historical (legacy ticket_resolved kind) AND new (comment+decision)
    // shapes converge in the same replay.
    const lifecycle: Message[] = [];
    for (const m of threadMessages) {
        if (m.status !== "approved") continue;
        if (m.kind === "comment_added") {
            const d = parseMeta(m.meta ?? null).decision;
            if (d?.kind === "resolution" && d.status === "accepted") {
                lifecycle.push({
                    ...m,
                    kind: "ticket_resolved",
                    by_agent: d.decided_by ?? m.by_agent,
                    created_at: d.decided_at ?? m.created_at,
                });
            }
            continue;
        }
        lifecycle.push(m);
    }
    lifecycle.sort((a, b) => a.id - b.id);
    let closedFlag = false;
    let resolvedFlag = false;
    let resolvedBy: string | null = null;
    let resolvedAt: string | null = null;
    let blockedFlag = false;
    let blockedBy: string | null = null;
    let blockedAt: string | null = null;
    for (const ev of lifecycle) {
        if (ev.kind === "ticket_closed") closedFlag = true;
        else if (ev.kind === "ticket_reopened") {
            closedFlag = false;
            resolvedFlag = false;
            resolvedBy = null;
            resolvedAt = null;
            blockedFlag = false;
            blockedBy = null;
            blockedAt = null;
        } else if (ev.kind === "ticket_resolved") {
            resolvedFlag = true;
            resolvedBy = ev.by_agent;
            resolvedAt = ev.created_at;
        } else if (ev.kind === "ticket_blocked") {
            blockedFlag = true;
            blockedBy = ev.by_agent;
            blockedAt = ev.created_at;
        }
    }
    const closed = closedFlag || t.status === "rejected";
    // resolved stays true even after the ticket is closed — the UI uses the
    // pair (closed, resolved) to distinguish "closed because resolved" from
    // "closed without explicit resolution" (wontfix / abandoned / dup).
    // Reopen still zeroes resolvedFlag inside the replay loop.
    const resolved = resolvedFlag;
    // Same idea for blocked (#B.119): persists past close so the UI can
    // still tell "closed after agent escalation" from a normal resolve.
    const blocked = blockedFlag;
    // Verbosity (#B.87 palier 2): default is summary now — header only,
    // no body, no comments array. Pass `full=1` to opt back into the
    // full thread. Old `summary=0` accepted as the explicit override
    // for symmetry with /api/tickets. `brief=1` and `digest=1` both
    // imply the thread shape too — opting into one of them means the
    // caller wants the reshaped read, not the bare header.
    const fullThread =
        req.query.full === "1" ||
        req.query.summary === "0" ||
        req.query.brief === "1" ||
        req.query.digest === "1";
    const summary = !fullThread;
    const headerBase = {
        id: t.id,
        project: t.project,
        title: t.edited_title ?? t.title,
        summary: t.summary ?? null,
        by_agent: t.by_agent,
        created_at: t.created_at,
        status: t.status,
        closed,
        resolved,
        resolved_by: resolved ? resolvedBy : null,
        resolved_at: resolved ? resolvedAt : null,
        blocked,
        blocked_by: blocked ? blockedBy : null,
        blocked_at: blocked ? blockedAt : null,
        scope: t.scope,
        postponed_until: t.postponed_until ?? null,
        intent: t.intent,
        priority: t.priority ?? "normal",
        parent_ticket_id: t.parent_ticket_id ?? null,
        sub_tickets: listSubTickets(t.id),
        tags: listMessageTags(t.id),
        // #B.104: sidecar metadata (question-answer audit, etc.).
        // Frontend reads this to render the "X/Y open" chip beside
        // questions without round-tripping to the server.
        meta: t.meta ?? null,
    };
    if (summary) {
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return res.json({
            ticket: headerBase,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        });
    }
    // #B.130 phase 2: brief mode. Reshapes the thread to drop the
    // already-summarized prefix and ship only the canonical pivot
    // line + everything after it.
    //
    // #B.21X (this change): pivot-cut. Scan approved comment_added
    // from newest → oldest, find the first one carrying
    // meta.summary_until — that's the pivot. The pivot's contract
    // ("ticket state AFTER this comment") makes it strictly lossless
    // to drop every earlier comment_added: they're all captured in
    // that one line. The pivot ships with body stripped (summary_until
    // IS its body); every comment_added AFTER the pivot keeps its
    // full body (that's the active "now" the reader needs).
    //
    // Lifecycle events (closed / reopened / resolved / blocked /
    // sub-added / referenced / relation) are always kept regardless
    // of position — they're small, semantically distinct, and not
    // covered by summary_until.
    //
    // Fallback: if no comment in the thread carries summary_until
    // (legacy threads, pure-human threads), revert to the legacy
    // tail-based brief — keep the last `tail` bodies intact, collapse
    // older comments with summary_until-when-present, keep bodies
    // otherwise. So brief is never lossy-by-absence.
    //
    // #B.21X (this change): digest mode. `digest: true` returns the
    // header plus an ordered `digest[]` of the thread's summary_until
    // snapshots — bird's-eye progression for cross-ticket scans.
    // Optional `digest_limit=N` trims to the last N snapshots. Ignored
    // when full or brief is set.
    const brief = req.query.brief === "1";
    const digest = req.query.digest === "1";
    if (digest && !brief) {
        const limitRaw = req.query.digest_limit;
        const limitParsed = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : NaN;
        const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? limitParsed : null;
        const snapshots = threadMessages
            .filter((m) => m.kind === "comment_added" && m.status === "approved")
            .map((m) => {
                const su = parseMeta(m.meta ?? null).summary_until;
                if (!su) return null;
                return {
                    id: m.id,
                    hashid: m.hashid,
                    by_agent: m.by_agent,
                    created_at: m.created_at,
                    summary_until: su,
                };
            })
            .filter((x): x is { id: number; hashid: string | null; by_agent: string; created_at: string; summary_until: string } => x !== null);
        const trimmed = limit !== null ? snapshots.slice(-limit) : snapshots;
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return res.json({
            ticket: headerBase,
            digest: trimmed,
            digest_limit: limit ?? undefined,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        });
    }
    // #B.202: `tail=N` survives for the no-pivot fallback path. When
    // a pivot is found, tail is a no-op (the cut is semantic, not
    // positional).
    const tailRaw = req.query.tail;
    const tailParsed = typeof tailRaw === "string" ? Number.parseInt(tailRaw, 10) : NaN;
    const tail = Number.isFinite(tailParsed) && tailParsed > 0 ? tailParsed : 1;
    let outComments = enrichRelationStages(withTags(threadMessages));
    let pivotCommentId: number | null = null;
    let pivotApplied = false;
    if (brief) {
        for (const m of [...threadMessages].reverse()) {
            if (m.kind !== "comment_added" || m.status !== "approved") continue;
            const su = parseMeta(m.meta ?? null).summary_until;
            if (su) {
                pivotCommentId = m.id;
                break;
            }
        }
        if (pivotCommentId !== null) {
            pivotApplied = true;
            const cutId = pivotCommentId;
            outComments = outComments
                .filter((m) => m.kind !== "comment_added" || m.id >= cutId)
                .map((m) => {
                    if (m.kind !== "comment_added") return m;
                    const su = parseMeta(m.meta ?? null).summary_until ?? null;
                    if (m.id === cutId) {
                        return { ...m, body: null, edited_body: null, summary_until: su } as typeof m;
                    }
                    return { ...m, summary_until: su } as typeof m;
                });
        } else {
            const keepIds = new Set<number>();
            const approvedIds = threadMessages
                .filter((m) => m.kind === "comment_added" && m.status === "approved")
                .map((m) => m.id)
                .sort((a, b) => b - a)
                .slice(0, tail);
            for (const id of approvedIds) keepIds.add(id);
            outComments = outComments.map((m) => {
                if (m.kind !== "comment_added" || keepIds.has(m.id)) return m;
                const meta = parseMeta(m.meta ?? null);
                const summaryUntil = meta.summary_until ?? null;
                if (!summaryUntil) {
                    return { ...m, summary_until: null } as typeof m;
                }
                return { ...m, body: null, edited_body: null, summary_until: summaryUntil } as typeof m;
            });
        }
    }
    // #309: user-deleted comments (only present when include_deleted=1) ship
    // as tombstones — strip the body so the UI shows a placeholder, never the
    // original text. `meta.deleted` stays so the frontend renders the marker.
    outComments = outComments.map((m) =>
        m.kind === "comment_added" && parseMeta(m.meta ?? null).deleted
            ? ({ ...m, body: null, edited_body: null } as typeof m)
            : m,
    );
    // #B.123 phase B: surface the active typed relations alongside the
    // existing parent/sub-ticket lineage. Each relation is enriched
    // with the target ticket's lifecycle stage (open / closed /
    // closed-resolved / rejected) so the chip can render a state
    // badge — david: "dans la nouvelle présentation on voit plus
    // l'état du ticket en relation".
    const typedRelations = listTypedRelationsForTicket(id);
    const targetStages = typedRelations.length > 0
        ? getTicketStages(typedRelations.map((r) => r.target_ticket_id))
        : new Map<number, string>();
    const typedRelationsWithStage = typedRelations.map((r) => ({
        ...r,
        target_stage: targetStages.get(r.target_ticket_id) ?? "open",
    }));
    // #283: resolve `/uploads/<sha>.<ext>` refs in the bodies we're about to
    // ship into ready-to-open attachments, so a cold-start agent doesn't have
    // to reverse-engineer where the file lives on disk. `local` is true only
    // for same-host (UDS / local-trust) callers — then `uri` is a `file://`
    // path; remote/browser callers get the HTTP ref. Only scan the bodies
    // actually present in the response (brief mode collapses pre-pivot ones).
    const ticketBody = t.edited_body ?? t.body;
    const localTrust =
        (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const attachments = resolveAttachments(
        [ticketBody, ...outComments.map((c) => c.edited_body ?? c.body)],
        localTrust,
    );
    res.json({
        ticket: {
            ...headerBase,
            body: ticketBody,
            relations: typedRelationsWithStage,
        },
        comments: outComments,
        attachments,
        focus_message_id: focusMessageId,
        brief,
        // `pivot_comment_id` surfaces the cut point when brief mode
        // applied the pivot-cut. Null when brief fell back to the
        // legacy tail-keep (no summary_until in thread). `tail` is
        // only relevant in that fallback path.
        pivot_comment_id: brief ? pivotCommentId : undefined,
        tail: brief && !pivotApplied ? tail : undefined,
    });
});

/**
 * Decorate ticket_referenced / ticket_sub_added pseudo-comments with the
 * `source_ticket_stage` of their target so the UI can render a small
 * state badge next to the ref (per #B.70 follow-up). Batched: one
 * lookup for every distinct source_ticket_id in the thread.
 */
function enrichRelationStages<T extends { id: number; kind: string; source_ticket_id?: number | null }>(comments: T[]): (T & { source_ticket_stage?: string })[] {
    const sourceIds = new Set<number>();
    for (const c of comments) {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            sourceIds.add(c.source_ticket_id);
        }
    }
    if (sourceIds.size === 0) return comments;
    const stages = getTicketStages([...sourceIds]);
    return comments.map((c) => {
        if (
            (c.kind === "ticket_referenced" || c.kind === "ticket_sub_added") &&
            typeof c.source_ticket_id === "number"
        ) {
            return { ...c, source_ticket_stage: stages.get(c.source_ticket_id) ?? "open" };
        }
        return c;
    });
}
