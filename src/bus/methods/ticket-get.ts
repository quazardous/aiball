/** #3063 — a ticket read: its header, and its thread in the shape asked. */
import { z } from "zod";
import { latestDecision, replayLifecycle } from "../../db/ticket-closed.js";
import { moderationRefusal } from "../../moderation-gate.js";
import { isMachineLocal } from "../../machine-secret.js";
import { consumerIdOf, defineMethod, Refusal } from "../methods.js";
import { flag } from "../params.js";
import { ERROR_CODES } from "../../domain.js";
import { computeActionableTicketIds } from "../../db/projects.js";
import { type FeedPagination, paginateFeed } from "../../queries/feed-paginate.js";
import { type Message, getConsumer, isHuman, getMessage, getMessageByHashid, getTicketStages, getTicketTitles, getTicketTokenUsage, listMessageTags, listMessages, listSubTickets, listTypedRelationsForTicket, resolveAttachments, ticketUnreadFlags } from "../../db.js";
import { getInboxAgg, liveStep } from "../../db/inbox-agg.js";
import { holding, ticketClaimHeldUntil } from "../../db/claim-hold.js";
import { isLineageRelationKind } from "../../relations.js";
import { listSubscriptions } from "../../db/subscriptions.js";
import { milestoneProgress, milestonesOf } from "../../db/milestones.js";
import { parseMeta } from "../../questions.js";
import { projectCriticalTicket } from "../../db/critical-ticket.js";
import { ticketHasPayload } from "../../db/payloads.js";
import { withTags, withVotes } from "../../queries/decorate.js";
import { enrichRelationStages } from "../../queries/tickets.js";

/**
 * One ticket, by id, comment id or hashid (a comment resolves to its thread,
 * with `focus_message_id`). The header alone by default; `full`, `brief`
 * (from the latest summary_until on) or `digest` (the snapshots) for the
 * thread. `actionable`, `claimable`, `unread` and the votes are the caller's.
 */
defineMethod({
    name: "ticket.get",
    who: ["human", "agent"],
    params: z.object({
        id: z.union([z.string(), z.number()]),
        include_deleted: flag,
        full: flag,
        summary: flag,
        brief: flag,
        digest: flag,
        digest_limit: z.coerce.string().optional(),
        tail: z.coerce.string().optional(),
        offset: z.coerce.string().optional(),
        limit: z.coerce.string().optional(),
        order: z.string().optional(),
    }),
    run: (caller, p) => {
    // The :id param accepts either:
    //   - an integer ticket id (#B<id>) → resolved directly,
    //   - an integer comment id (legacy #C<id>) → resolved to parent thread
    //     with focus_message_id set,
    //   - a 6-char hashid string (canonical #C<hashid>) → looked up by
    //     hashid then resolved like an integer comment.
    const raw = String(p.id);
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    let requested: Message | null = null;
    if (numeric !== null) {
        requested = getMessage(numeric);
    }
    if (!requested) {
        requested = getMessageByHashid(raw);
    }
    if (!requested) throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
    // If the id is a comment (or close/reopen event), resolve up to its
    // parent ticket and attach `focus_message_id` so the UI can scroll to
    // the right place. Lets `#N` references in markdown be opened blindly.
    let t = requested;
    let focusMessageId: number | null = null;
    if (t.kind !== "ticket_created") {
        if (!t.ticket_id) throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
        const parent = getMessage(t.ticket_id);
        if (!parent || parent.kind !== "ticket_created") {
            throw new Refusal(404, "ticket not found", ERROR_CODES.TICKET_NOT_FOUND);
        }
        focusMessageId = requested.id;
        t = parent;
    }
    const id = t.id;
    // Return tickets in any status so the moderator can open pending or
    // rejected ones from the inbox and act on them inline.
    // #2171 — narrow to THIS thread. Without the ticket id this loaded every
    // message of the project (6014 on aiball) and filtered in JS down to the
    // handful below, so the header-only probe — the mode documented as the
    // CHEAP one — cost exactly what the full thread cost: 144 ms either way.
    // The filter already existed; #2159 added it so the inbox aggregate could
    // rebuild one entry, and this route never picked it up. 144 ms -> 11 ms.
    const all = listMessages({ project: t.project, ticket_id: id });
    // Thread feed = comments + lifecycle events, inline. Lifecycle events
    // (close / reopen / resolved) are rendered as system rows in the UI so
    // the reader can see who flipped the state and when. Order: ASC by id.
    // #309: the UI opts into seeing user-deleted comments (as tombstones)
    // via ?include_deleted=1; default (and every MCP read) never sees them.
    const includeDeleted = p.include_deleted === true;
    const threadMessages = all
        .filter(
            (m) =>
                m.ticket_id === id &&
                (m.kind === "comment_added" ||
                    m.kind === "ticket_closed" ||
                    m.kind === "ticket_reopened" ||
                    m.kind === "ticket_resolved" ||
                    m.kind === "ticket_blocked" ||
                    m.kind === "claim_taken_over" ||
                    m.kind === "ticket_sub_added" ||
                    m.kind === "ticket_referenced" ||
                    m.kind === "dependency_closed" ||
                    m.kind === "related_closed" ||
                    m.kind === "dependency_rejected" ||
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
    // #3251 — the one replay (db/ticket-closed.ts), the inbox's too.
    const life = replayLifecycle(threadMessages);
    const closed = life.closed || t.status === "rejected";
    // resolved stays true even after the ticket is closed — the UI uses the
    // pair (closed, resolved) to distinguish "closed because resolved" from
    // "closed without explicit resolution" (wontfix / abandoned / dup).
    // A reopen still clears it (replayLifecycle).
    const resolved = life.resolved;
    // Same idea for blocked (#B.119): persists past close so the UI can
    // still tell "closed after agent escalation" from a normal resolve.
    const blocked = life.blocked;
    // Verbosity (#B.87 palier 2): default is summary now — header only,
    // no body, no comments array. Pass `full=1` to opt back into the
    // full thread. Old `summary=0` accepted as the explicit override
    // for symmetry with /api/tickets. `brief=1` and `digest=1` both
    // imply the thread shape too — opting into one of them means the
    // caller wants the reshaped read, not the bare header.
    const fullThread =
        p.full === true ||
        p.summary === false ||
        p.brief === true ||
        p.digest === true;
    const summary = !fullThread;
    // #1350 — per-consumer `actionable`/`claimable` on the single-ticket
    // header, mirroring the list-row flags (see ~644-673). The wake renderer
    // reads `claimable` on the head event's ticket to decide the
    // "(fyi — action is not mandatory)" suffix: a subscriber who is not the
    // responsible maintainer (non-claimable) gets an info wake, not a triage
    // push. Same helper + same owned-projects/can-claim gate as the list, so
    // the two views can never disagree.
    const flagConsumer = consumerIdOf(caller);
    // #2102 — one ticket's header asks about one ticket.
    const { actionableIds: hdrActionableIds } = computeActionableTicketIds(flagConsumer, [t.id]);
    const hdrOwnedProjects = new Set(
        listSubscriptions(flagConsumer)
            .filter((s) => s.role === "owner")
            .map((s) => s.project),
    );
    const hdrConsumerRow = getConsumer(flagConsumer);
    const hdrCanClaim =
        (!hdrConsumerRow || hdrConsumerRow.can_claim !== false) &&
        caller.no_claim_hint !== true;
    const hdrActionable = hdrActionableIds.has(t.id);
    const hdrClaimable = hdrCanClaim
        ? hdrActionable && hdrOwnedProjects.has(t.project)
        : t.assignee === flagConsumer && hdrActionable;
    const claimHeldEnd = ticketClaimHeldUntil(t);
    const headerBase = {
        id: t.id,
        project: t.project,
        title: t.title,
        summary: t.summary ?? null,
        by_agent: t.by_agent,
        created_at: t.created_at,
        status: t.status,
        closed,
        resolved,
        resolved_by: life.resolved_by,
        resolved_at: life.resolved_at,
        blocked,
        blocked_by: life.blocked_by,
        blocked_at: life.blocked_at,
        // #3251 — the thread's latest decision (any status): the one to decide, the buttons' place.
        latest_decision: latestDecision(t, threadMessages),
        scope: t.scope,
        postponed_until: t.postponed_until ?? null,
        intent: t.intent,
        priority: t.priority ?? "normal",
        // #2910 — the edit panel reads the level from here: without it a
        // milestone reloaded as a task (Level "task", no "Version" label).
        level: t.level ?? "task",
        // #418/#436: assignment (responsibility) + claim (focus) — distinct
        // fields, surfaced on the thread header so the UI renders "assigned to X"
        // and/or "claimed by Y". `is_claim` kept for back-compat (claimed?).
        assignee: t.assignee ?? null,
        assigned_by: t.assigned_by ?? null,
        assigned_at: t.assigned_at ?? null,
        claimant: t.claimant ?? null,
        claimed_at: t.claimed_at ?? null,
        // #2460 — a lapsed claim stays on record (claimant, claimed_at) but is
        // no longer held: `is_claim` says whether it is, `claim_until` until when
        // (the later of the assign window and the holder's working protection).
        // It was `claimant != null`, and showed a claim the step gate refused.
        is_claim: claimHeldEnd !== null && claimHeldEnd > Date.now(),
        claim_until: claimHeldEnd !== null ? new Date(claimHeldEnd).toISOString() : null,
        // #3038 — who holds it now, and how: the same rule as the list row.
        ...holding(t, claimHeldEnd, Date.now()),
        parent_ticket_id: t.parent_ticket_id ?? null,
        sub_tickets: listSubTickets(t.id),
        // #2910 — the milestone this ticket belongs to; on a milestone, its tickets.
        milestone: milestonesOf([t.id]).get(t.id) ?? null,
        ...(t.level === "milestone" ? { milestone_progress: milestoneProgress(t.id) } : {}),
        // #2765 — the ticket's last word is a step: what it resumes on. Same
        // aggregate as the list row and the UI.
        step: liveStep(getInboxAgg(t.project).get(t.id), !closed && t.status !== "rejected"),
        // #2770 david — flag the project's critical ticket on its detail too.
        critical: (() => {
            const c = !closed && t.status === "approved" ? projectCriticalTicket(t.project) : null;
            return c && c.id === t.id ? { holds: c.holds, quiet: c.quiet } : null;
        })(),
        tags: listMessageTags(t.id),
        // #B.104: sidecar metadata (question-answer audit, etc.).
        // Frontend reads this to render the "X/Y open" chip beside
        // questions without round-tripping to the server.
        meta: t.meta ?? null,
        // #406 (david 7mybeg "dans le détail ticket on a pas l'info du cumul
        // d'effort"): expose the per-ticket token tally on the GET header too,
        // not just list rows — the thread badge (ThreadHeader) reads it, and the
        // detail view fetches via ticket_get, so without this the badge had no
        // data when a ticket was opened directly. null until any usage captured.
        token_usage: getTicketTokenUsage([t.id]).get(t.id) ?? null,
        // #569 david `j8t4qa` A+C : flag explicite que l'agent peut tester
        // AVANT de poster un `ticket_reply then:"resolved"` / `then:"plan"`.
        // True ssi le ticket est `status: "approved"`. Faux sur pending /
        // rejected — l'API renverra de toute façon HTTP 409
        // (PARENT_PENDING_MODERATION) si l'agent tente, mais le flag
        // est plus pédagogique : l'agent lit le ticket → voit le flag →
        // décide d'attendre / d'asker un plain comment.
        // #3249 — through the one moderation gate, for this reader: a human may
        // propose on a pending ticket, an agent may not (a resolution: the
        // strictest; a plan amending one waiting is the only other opening).
        decision_proposable: moderationRefusal("propose", t, { human: isHuman(flagConsumer), decisionKind: "resolution" }) === null,
        // #2112 david: "si pas de payload doit être complètement invisible".
        // Invisible means the UI must not even ASK — a `GET …/payload` on every
        // thread open, answered 404 for all but a handful of tickets, is a
        // round-trip and a log line for nothing. This flag lets the panel stay
        // unmounted rather than merely render empty. It says a payload EXISTS,
        // never anything about what is in it.
        has_payload: ticketHasPayload(t.id),
        // #596 david `sa44wy` : ≥1 unseen ping on this thread for the
        // requesting consumer. Frontend uses it to skip the
        // "marking-as-read" pulse when landing on an already-read ticket.
        unread: ticketUnreadFlags(consumerIdOf(caller), [t.id]).get(t.id) ?? false,
        // #1350 — per-consumer work-landscape flags, same semantics as the
        // list rows. `claimable` is the wake renderer's discriminator for the
        // info-vs-triage suffix on event wakes.
        actionable: hdrActionable,
        claimable: hdrClaimable,
        // #928 david `2uxj45` (Slice 1) : ta dernière décision postée sur
        // ce ticket (then:plan / then:resolved / then:wontfix /
        // then:escalate) — surface l'état pending/accepted/rejected en
        // header. Évite à l'agent de drill dans comments[].meta.decision
        // pour savoir "où en est ma décision" (cf. bug #951 où j'avais
        // claim "pending" alors qu'accepted). null = aucune décision
        // posée par ce consumer sur ce ticket.
        your_latest_decision: (() => {
            const consumer = consumerIdOf(caller);
            let latest: { kind: string; status: string; hashid: string | null; decided_at: string | null } | null = null;
            let latestId = -1;
            for (const m of threadMessages) {
                if (m.kind !== "comment_added") continue;
                if (m.by_agent !== consumer) continue;
                if (m.status === "rejected") continue;
                const dec = parseMeta(m.meta ?? null).decision;
                if (!dec || !dec.kind || !dec.status) continue;
                if (m.id > latestId) {
                    latestId = m.id;
                    latest = {
                        kind: dec.kind,
                        status: dec.status,
                        hashid: m.hashid ?? null,
                        decided_at: dec.decided_at ?? null,
                    };
                }
            }
            return latest;
        })(),
    };
    if (summary) {
        const commentCount = threadMessages.filter(
            (m) => m.kind === "comment_added" && m.status !== "rejected",
        ).length;
        return {
            ticket: headerBase,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        };
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
    const brief = p.brief === true;
    const digest = p.digest === true;
    if (digest && !brief) {
        const limitRaw = p.digest_limit;
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
        return {
            ticket: headerBase,
            digest: trimmed,
            digest_limit: limit ?? undefined,
            comment_count: commentCount,
            focus_message_id: focusMessageId,
        };
    }
    // #B.202: `tail=N` survives for the no-pivot fallback path. When
    // a pivot is found, tail is a no-op (the cut is semantic, not
    // positional).
    const tailRaw = p.tail;
    const tailParsed = typeof tailRaw === "string" ? Number.parseInt(tailRaw, 10) : NaN;
    const tail = Number.isFinite(tailParsed) && tailParsed > 0 ? tailParsed : 1;
    // #518 — décorer avec votes_summary (up/down + viewer's mine). Le viewer
    // est consumerIdOf(caller) : chaque user voit son `mine` calculé pour lui.
    let outComments = enrichRelationStages(withVotes(withTags(threadMessages), consumerIdOf(caller)));
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
                        return { ...m, body: null, summary_until: su } as typeof m;
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
                return { ...m, body: null, summary_until: summaryUntil } as typeof m;
            });
        }
    }
    // #309: user-deleted comments (only present when include_deleted=1) ship
    // as tombstones — strip the body so the UI shows a placeholder, never the
    // original text. `meta.deleted` stays so the frontend renders the marker.
    outComments = outComments.map((m) =>
        m.kind === "comment_added" && parseMeta(m.meta ?? null).deleted
            ? ({ ...m, body: null } as typeof m)
            : m,
    );
    // #396 (david h4gp5z): paginate + order the full thread feed. Lets a reader
    // page through a big thread — or grab the last N entries WITH full bodies —
    // instead of pulling the whole 80 KB at once. Only in pure full mode (brief
    // and digest have their own shapes). Pure logic in feed-paginate.ts.
    let pagination: FeedPagination | undefined;
    if (!brief) {
        const paged = paginateFeed(outComments, {
            offset: p.offset,
            limit: p.limit,
            order: p.order,
        });
        outComments = paged.feed;
        pagination = paged.pagination;
    }
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
    // #2432 — and with its title, for the chip's tooltip.
    const targetTitles = typedRelations.length > 0
        ? getTicketTitles(typedRelations.map((r) => r.target_ticket_id))
        : new Map<number, string>();
    const typedRelationsWithStage = typedRelations.map((r) => ({
        ...r,
        target_stage: targetStages.get(r.target_ticket_id) ?? "open",
        target_title: targetTitles.get(r.target_ticket_id) ?? null,
    }));
    // #283: resolve `/uploads/<sha>.<ext>` refs in the bodies we're about to
    // ship into ready-to-open attachments, so a cold-start agent doesn't have
    // to reverse-engineer where the file lives on disk. `local` is true only
    // for same-host (UDS / local-trust) callers — then `uri` is a `file://`
    // path; remote/browser callers get the HTTP ref. Only scan the bodies
    // actually present in the response (brief mode collapses pre-pivot ones).
    const ticketBody = t.body;
    const localTrust = isMachineLocal(caller);
    const attachments = resolveAttachments(
        [ticketBody, ...outComments.map((c) => c.body)],
        localTrust,
    );
    // #3040 — each comment also lists its own uploads, when it has any, so a
    // client rendering one comment need not scan the thread-wide list.
    outComments = outComments.map((c) => {
        const own = resolveAttachments([c.body], localTrust);
        return own.length > 0 ? { ...c, attachments: own } : c;
    });
    return {
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
        // #396: present only when the full feed was paginated/reordered.
        pagination,
    };
    },
});
