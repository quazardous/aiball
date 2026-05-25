import {
    getMessage,
    insertMessage,
    moveTicket,
    insertRelationEvent,
    insertTypedRelation,
    updateMessageStatus,
    upsertTicketSubscription,
    listPendingResolvedForTicket,
    listPendingResolutionDecisionsForTicket,
    applyMessageDecision,
    listPendingLifecycleForTicket,
    deletePingsForMessage,
    releaseTicketHold,
    setTicketClaim,
    ensureConsumer,
    isHuman,
    INTENTS,
    type Message,
    type NewMessage,
    type MessageKind,
    type Intent,
} from "./db.js";
import { DECISION_KINDS, isDecisionKind } from "./decisions.js";
import { isHeldByOther } from "./db/assignment-gate.js";
import { assignWindowSec } from "./autopoll/config.js";
import { evaluate } from "./rules.js";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";
import { emitLifecycle } from "./event-bus.js";
import { fanOutPings, fanOutMentions } from "./notifications.js";

// User-postable subset of MESSAGE_KINDS: excludes `ticket_sub_added`
// and `ticket_referenced` (daemon-emitted on relations) AND
// `ticket_blocked` since the agent→human blocked direction was
// retired by david (#B.129 wording pass): the primitive induced
// misuse (agents temporizing with blocked when they were just
// waiting on input). Historical rows stay in the DB and continue to
// render via the lifecycle replay; only emission is gated.
export const VALID_KINDS = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
    "ticket_reopened",
    "ticket_resolved",
] as const satisfies readonly MessageKind[];

export interface ValidationError {
    error: string;
}

export function validateNewMessage(input: unknown): ValidationError | NewMessage {
    if (!input || typeof input !== "object") return { error: "body must be object" };
    const o = input as Record<string, unknown>;
    if (typeof o.project !== "string" || !o.project) {
        return { error: "project required" };
    }
    if (typeof o.kind !== "string" || !(VALID_KINDS as readonly string[]).includes(o.kind)) {
        return { error: `kind must be one of ${VALID_KINDS.join(", ")}` };
    }
    const kind = o.kind as MessageKind;
    if (kind !== "ticket_created") {
        if (typeof o.ticket_id !== "number" || !o.ticket_id) {
            return { error: `ticket_id required for kind=${kind}` };
        }
    }
    if (kind === "ticket_created" && (typeof o.title !== "string" || !o.title)) {
        return { error: "title required for ticket_created" };
    }
    let intent: Intent | null = null;
    if (o.intent !== undefined && o.intent !== null) {
        if (typeof o.intent !== "string" || !INTENTS.includes(o.intent as Intent)) {
            return { error: `intent must be one of ${INTENTS.join(", ")}` };
        }
        intent = o.intent as Intent;
    }
    // #B.214: no humans-only enforcement on `panic` — david (#w47f9m):
    // "un message doit de toute façon etre approuvé". Moderation is
    // the gate; restricting at the validator would double-gate and
    // also block legitimate agent-to-agent cases.
    // #B.129 decision-on-comment: validate optional `decision_kind`.
    // Only meaningful on comment_added today; other kinds drop it.
    let decisionKind: string | null = null;
    if (o.decision_kind !== undefined && o.decision_kind !== null) {
        if (typeof o.decision_kind !== "string") {
            return { error: "decision_kind must be a string" };
        }
        if (!isDecisionKind(o.decision_kind)) {
            return { error: `decision_kind must be one of ${DECISION_KINDS.join(", ")}` };
        }
        if (kind !== "comment_added") {
            return { error: `decision_kind only allowed on comment_added (got kind=${kind})` };
        }
        decisionKind = o.decision_kind;
    }
    // #B.130: `summary_until` on comments — author's one-line TLDR of
    // the thread state *up to this comment*. Powers brief-mode reads
    // and densifies the thread context. Mandatory on comment_added
    // FOR AGENTS (david: "ship en obligatoire" + "pour l'humain le
    // summary est pas obligatoire") — human consumers skip the
    // requirement; only agents must summarize what they post.
    let summaryUntil: string | null = null;
    const byAgent = typeof o.by_agent === "string" ? o.by_agent : null;
    const authorIsHuman = byAgent ? isHuman(byAgent) : false;
    if (kind === "comment_added") {
        // #B.130 follow-up: cap removed entirely. Treat summary_until
        // like body — a free-text field. Earlier caps (200, then 500)
        // truncated mid-word and forced action-delta framings even
        // when a richer whole-ticket-state TLDR was needed. David:
        // "ça devrait être un champ comme body".
        const provided = typeof o.summary_until === "string" ? o.summary_until.trim() : "";
        if (!provided && !authorIsHuman) {
            return { error: "summary_until is required on comment_added for agent authors (one-line TLDR of the thread state up to this comment). Humans skip the requirement." };
        }
        if (o.summary_until !== undefined && o.summary_until !== null && typeof o.summary_until !== "string") {
            return { error: "summary_until must be a string" };
        }
        summaryUntil = provided || null;
    } else if (o.summary_until !== undefined && o.summary_until !== null && o.summary_until !== "") {
        return { error: `summary_until only allowed on comment_added (got kind=${kind})` };
    }
    // #B.245 tristate: composer-side `scope`. One of
    // `internal | default | broadcast`. Applies to every kind
    // (ticket_created and comment_added alike — each event decides
    // its own fan-out per david #79h7zk). When absent, the column
    // default `'default'` applies server-side; we forward `undefined`
    // rather than coercing here.
    let scope: "internal" | "default" | "broadcast" | undefined = undefined;
    if (o.scope !== undefined && o.scope !== null) {
        if (typeof o.scope !== "string") {
            return { error: "scope must be a string" };
        }
        if (o.scope !== "internal" && o.scope !== "default" && o.scope !== "broadcast") {
            return { error: "scope must be one of internal, default, broadcast" };
        }
        scope = o.scope as "internal" | "default" | "broadcast";
    }
    return {
        project: o.project,
        kind,
        ticket_id: typeof o.ticket_id === "number" ? o.ticket_id : null,
        parent_id: typeof o.parent_id === "number" ? o.parent_id : null,
        title: typeof o.title === "string" ? o.title : null,
        body: typeof o.body === "string" ? o.body : null,
        // Summary forwarded as-is (#B.87). NewTicket inserts it; other
        // kinds ignore it. Empty string maps to null so an explicit
        // clear works.
        summary: typeof o.summary === "string" && o.summary !== "" ? o.summary : null,
        by_agent: typeof o.by_agent === "string" ? o.by_agent : null,
        intent: kind === "ticket_created" ? intent : null,
        decision_kind: decisionKind,
        summary_until: summaryUntil,
        scope,
    };
}

/**
 * Auto-subscribe the message author to its parent ticket. Called for every
 * inserted message regardless of moderation outcome — even if the message
 * itself is rejected later, the author has shown intent to follow the
 * thread. No-ops if by_agent is unset (anonymous post).
 */
function autoSubscribeAuthor(msg: Message): void {
    if (!msg.by_agent) return;
    const ticketId = msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (!ticketId) return;
    upsertTicketSubscription(msg.by_agent, ticketId);
}

/**
 * Lifecycle events authored by the ticket's original creator (close /
 * reopen / resolved) skip moderation — the author already had authority
 * over the thread. Other agents posting these events still go through the
 * rule engine (rules + strategy + human bypass).
 *
 * Note: ticket_resolved is intentionally a "soft" signal that anyone can
 * propose — when posted by a non-owner, it goes through review and shows
 * up as a proposal in the UI. The reporter validates by closing.
 */
function isOwnerLifecycleEvent(input: NewMessage): boolean {
    if (
        input.kind !== "ticket_closed" &&
        input.kind !== "ticket_reopened" &&
        input.kind !== "ticket_resolved"
    ) {
        return false;
    }
    if (!input.by_agent || !input.ticket_id) return false;
    const parent = getMessage(input.ticket_id);
    return (
        parent?.kind === "ticket_created" &&
        parent.by_agent === input.by_agent
    );
}

/**
 * Hard rule: only the ticket reporter (the agent who opened the thread) can
 * close it. Anyone else who wants to signal "I think this is done" should
 * post `ticket_resolved` (a soft proposal) — the reporter still validates
 * by closing.
 *
 * This is enforced before the message is even inserted, so the database
 * never holds a stray ticket_closed from a non-owner. Throws with a marker
 * the HTTP layer maps to 403.
 */
function assertCloseAuthority(input: NewMessage): void {
    if (input.kind !== "ticket_closed") return;
    if (!input.ticket_id) return;
    const parent = getMessage(input.ticket_id);
    if (!parent || parent.kind !== "ticket_created") return;
    if (input.by_agent && input.by_agent === parent.by_agent) return;
    // Human moderator bypass (#B.79): any consumer registered with
    // kind=human can close any ticket. Falls back to the env CSV
    // when the consumers table is empty (defensive at boot time).
    if (input.by_agent && isHuman(input.by_agent)) return;
    const err = new Error(
        `only the ticket reporter (${parent.by_agent ?? "unknown"}) can close this ticket — post ticket_resolved instead to propose resolution`,
    );
    (err as Error & { code?: string }).code = "FORBIDDEN_CLOSE";
    throw err;
}

/**
 * Extract every `#NN` / `#B.NN` / `#BNN` ticket reference from a body,
 * **outside** of code fences and inline-backtick spans (so `#123` inside
 * a code block stays inert, per #B.62). Returns unique numeric refs.
 *
 * `selfTicketId` is excluded so a body that mentions its own ticket
 * (e.g. "see also #B.42") doesn't trigger a self-referenced event.
 */
function extractTicketRefs(
    body: string | null | undefined,
    selfTicketId: number,
): number[] {
    if (!body) return [];
    // Strip code fences (triple-backtick) and inline-backtick spans so
    // refs inside them don't get linkified into events.
    const stripped = body
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
    const refs = new Set<number>();
    // Only the canonical letter-prefixed form: #B.NN, #B-NN, #B_NN,
    // #B/NN, #BNN. Bare `#NN` is intentionally NOT matched — it
    // produced too many false positives ("item #9", "step #2", …) per
    // user feedback on #B.62. Boundary on the left: start of input
    // or a non-word non-slash char (so /foo#3 doesn't match).
    const re = /(?:^|[^\w/])#B[._/-]?(\d+)\b/gi;
    for (const m of stripped.matchAll(re)) {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (n === selfTicketId) continue;
        refs.add(n);
    }
    return [...refs];
}

/**
 * Auto-emit cross-reference pseudo-comments triggered by a freshly
 * inserted message:
 *   - `ticket_sub_added` on parent thread when the message is a
 *     ticket_created with a parent_ticket_id.
 *   - `ticket_referenced` on each ticket mentioned in the message body.
 *
 * Each pseudo-comment is also fanned out + broadcast like a normal
 * message so subscribers to the target thread receive a ping (per
 * #B.61 follow-up + #B.62).
 */
function postRelationEvents(msg: Message, input: NewMessage): void {
    // Source ticket = the ticket the relation originates from. For a
    // ticket_created, the source IS the new ticket (its id). For a
    // comment_added, the source is the comment's parent thread.
    const sourceTicketId =
        msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (sourceTicketId === null) return;

    // 1. Sub-ticket lineage.
    if (msg.kind === "ticket_created" && input.parent_id) {
        const parent = getMessage(input.parent_id);
        if (parent && parent.kind === "ticket_created") {
            const pseudo = insertRelationEvent({
                target_ticket_id: parent.id,
                source_ticket_id: msg.id,
                kind: "ticket_sub_added",
                by_agent: msg.by_agent,
            });
            if (pseudo) {
                // Inherit scope from the source event (#B.245) so an
                // internal-scoped sub-ticket doesn't summon the parent
                // thread's followers via its sub_added pseudo.
                pseudo.scope = msg.scope;
                fanOutPings(pseudo);
                broadcast({ type: "message_created", data: pseudo });
            }
            // #271: dual-write the lineage into the typed-relations graph
            // so the parent/child link surfaces as a chip (read-only),
            // unifying with every other relation. `child_of` from the new
            // child → parent; the parent sees the reciprocal `parent_of`.
            // The ticket_sub_added pseudo above remains the timeline log;
            // this event drives the relations cartouche. Lineage relations
            // are filtered out of the timeline in the thread API so we
            // don't double-log. Best-effort — a failure here mustn't block
            // the ticket from being created.
            try {
                insertTypedRelation({
                    source_ticket_id: msg.id,
                    target_ticket_id: parent.id,
                    relation_kind: "child_of",
                    by_agent: msg.by_agent,
                });
            } catch {
                /* lineage relation is best-effort; the FK + sub_added log
                   already record the link */
            }
        }
    }

    // 2. Body cross-references (#B.NN in body, outside backticks).
    const refs = extractTicketRefs(msg.body, sourceTicketId);
    for (const refId of refs) {
        const target = getMessage(refId);
        if (!target || target.kind !== "ticket_created") continue;
        const pseudo = insertRelationEvent({
            target_ticket_id: target.id,
            source_ticket_id: sourceTicketId,
            kind: "ticket_referenced",
            by_agent: msg.by_agent,
        });
        if (pseudo) {
            // #B.245 tristate: when the source comment is internal, the
            // cross-ref pseudo lives in the target thread but doesn't
            // fan out — the referenced thread's subscribers shouldn't
            // be summoned by a quiet/internal mention. The pseudo
            // inherits the source scope so fanOutPings's own gate
            // picks up the right behavior.
            pseudo.scope = msg.scope;
            fanOutPings(pseudo);
            broadcast({ type: "message_created", data: pseudo });
        }
    }
}

/**
 * Single source of truth for "a new message arrived" — used by both the HTTP
 * API and the spool drainer so behavior is identical regardless of channel.
 */
export function submitMessage(input: NewMessage): Message {
    assertCloseAuthority(input);
    // Lazy-register the author so the moderator sees them in Settings >
    // Consumers and can tag kind/display_name retroactively (#B.79).
    // No-op when already present.
    if (input.by_agent) ensureConsumer(input.by_agent);
    let msg = insertMessage(input);
    autoSubscribeAuthor(msg);
    // Fan out delivery pings at INSERTION (not just at approval): subscribers
    // need to know "new activity landed on my ticket" even before the
    // moderator decides. `insertPing` is idempotent (onConflictDoNothing on
    // the (recipient, message_id) primary key), so the later approval-time
    // fan-out is a safe no-op. Pings on rejected messages are cleaned up by
    // the moderation handler (api.ts decide()).
    //
    // #B.245: internal-scoped messages bail out inside fanOutPings —
    // only @mentions (via fanOutMentions below) reach them.
    fanOutPings(msg);
    // Always announce the message: every UI list (pending, approved, tickets,
    // open thread) wants to know that a new row exists, regardless of how
    // moderation will resolve it.
    broadcast({ type: "message_created", data: msg });

    // Cross-reference pseudo-comments (`ticket_sub_added` + `ticket_referenced`)
    // — auto-emitted on the target threads. Side-effect only; the
    // returned msg refers to the original message. Run at insertion so
    // the pseudo-comments land in the thread even if moderation is
    // still pending; rejection cleanup is a future iteration if needed.
    if (msg.kind === "ticket_created" || msg.kind === "comment_added") {
        postRelationEvents(msg, input);
        // Force-deliver pings to `@<name>` mentions (per #B.71). Agent
        // names get a direct ping; project names fan out to the
        // project's owners + followers.
        fanOutMentions(msg);
    }

    const ownerLifecycle = isOwnerLifecycleEvent(input);
    // Historically `ticket_blocked` auto-approved too. The kind is
    // retired from the agent→human direction (david, 2026-05-15), so
    // VALID_KINDS now blocks emission. The defensive special-case is
    // kept in case a legacy MCP client still posts one — it'll fail
    // validation upstream, but if it slipped through somehow, the
    // historical auto-approve path stays.
    const autoApproveLifecycle = ownerLifecycle || input.kind === "ticket_blocked";
    const decision = autoApproveLifecycle
        ? { decision: "auto" as const, matched_rule_id: null }
        : evaluate({
            project: input.project,
            kind: input.kind,
            by_agent: input.by_agent ?? null,
        });
    if (decision.decision === "auto") {
        const updated = updateMessageStatus(
            msg.id,
            "approved",
            ownerLifecycle ? "owner" : "auto",
            decision.matched_rule_id,
        );
        if (updated) {
            msg = updated;
            deliverToOutbox(msg);
            fanOutPings(msg);
            // …and announce the auto-approval so subscribers transition state
            // (status: pending → approved) without polling.
            broadcast({ type: "message_decided", data: msg });
            // Closing a ticket is the canonical "yes, this is done" — any
            // dangling `ticket_resolved` proposals on this ticket are no
            // longer awaiting moderation, the close just validated them.
            // Auto-approve them so the inbox / UI stop surfacing stale
            // pending state.
            if (msg.kind === "ticket_closed" && msg.ticket_id !== null) {
                // Pending ticket_resolved on this ticket → auto-approve
                // (closing implies acceptance of the resolution proposal).
                for (const stale of listPendingResolvedForTicket(msg.ticket_id)) {
                    const promoted = updateMessageStatus(
                        stale.id,
                        "approved",
                        "owner",
                        null,
                    );
                    if (promoted) {
                        deliverToOutbox(promoted);
                        fanOutPings(promoted);
                        broadcast({ type: "message_decided", data: promoted });
                    }
                }
                // #B.129 phase 2: same idea for decision-on-comment
                // resolutions still pending — closing the ticket
                // implicitly accepts every dangling resolution decision.
                for (const c of listPendingResolutionDecisionsForTicket(msg.ticket_id)) {
                    const accepted = applyMessageDecision(
                        c.id,
                        "accepted",
                        msg.by_agent ?? "owner",
                    );
                    if (accepted) {
                        broadcast({ type: "message_edited", data: accepted });
                    }
                }
                // Pending ticket_closed / ticket_reopened on this ticket are
                // moot once a close lands → auto-reject them so they stop
                // polluting the moderation queue. Their pings get wiped too.
                for (const stale of listPendingLifecycleForTicket(
                    msg.ticket_id,
                    ["ticket_closed", "ticket_reopened"],
                    msg.id, // don't reject the close we just approved
                )) {
                    const rejected = updateMessageStatus(
                        stale.id,
                        "rejected",
                        "owner",
                        null,
                    );
                    if (rejected) {
                        deletePingsForMessage(stale.id);
                        broadcast({ type: "message_decided", data: rejected });
                    }
                }
                // #418/#436: a closed ticket is out of every pool — release BOTH
                // its assignment AND its claim so a later reopen starts back in the
                // shared pool (and the data stays clean). No-op when unheld.
                releaseTicketHold(msg.ticket_id);
            }
        }
    }
    // #418: auto-claim (discipline A) — an agent posting an APPROVED comment on a
    // ticket that nobody else actively holds claims (or refreshes) it for that
    // agent. Makes the multi-agent anti-collision structural, not behavioural:
    // the claim is a side effect of working, no `ticket_claim` discipline to
    // keep. Humans don't claim (they don't "work" a ticket in the agent sense —
    // same exclusion as the hot-zone). Skipped when another agent's claim is
    // still live (we never steal); the window expiry + auto-release on close keep
    // it self-maintaining.
    if (msg.kind === "comment_added" && msg.status === "approved" && msg.ticket_id != null) {
        const author = msg.by_agent;
        if (author && author !== "auto" && !isHuman(author)) {
            const t = getMessage(msg.ticket_id);
            if (t && t.kind === "ticket_created"
                && !isHeldByOther(t.assignee, t.claimant, t.claimed_at, author, Date.now(), assignWindowSec() * 1000)) {
                // #436: auto-claim sets the CLAIM (focus), not an assignment.
                // #439: stamp claimed_at with the COMMENT's created_at (not a fresh
                // now()) so a worked claim's claimed_at == the author's latest
                // comment timestamp exactly — one-focus's `lastMs >= claimedMs`
                // then keeps it (a fresh now() lands a few ms LATER → falsely "bare").
                setTicketClaim(msg.ticket_id, author, msg.created_at);
            }
        }
    }
    // #321 phase 1: emit the lifecycle event once the message has landed (and
    // its moderation status resolved). `msg.kind` discriminates the transition
    // (ticket_created / comment_added / ticket_closed / decision …). Additive —
    // alongside the inline fanOutPings/broadcast above; #322 will subscribe.
    emitLifecycle({ op: "created", message: msg });
    return msg;
}

/**
 * Orchestrate a ticket move (#294): mutate the head + post the audit
 * comment via moveTicket(), then re-fan the audit to the DESTINATION
 * project and broadcast so BOTH the source and destination project views
 * update live (source drops the ticket, destination picks it up).
 *
 * Returns the moved ticket header. Permission (reporter-or-human) and
 * target validation are the caller's job — see the `/tickets/:id/move`
 * route, which mirrors the postpone/unsnooze authority check. Throws
 * "ticket not found" when the id doesn't resolve to a ticket.
 */
export function moveTicketTo(
    ticketId: number,
    targetProject: string,
    byAgent: string | null,
): Message {
    const res = moveTicket(ticketId, targetProject, byAgent);
    if (!res) throw new Error("ticket not found");
    if (res.event) {
        fanOutPings(res.event);
        broadcast({ type: "message_created", data: res.event });
    }
    broadcast({ type: "message_edited", data: res.ticket });
    // #321 phase 1: the ticket changed project — emit so the rules engine can
    // re-evaluate attribution on the new project (#322).
    emitLifecycle({ op: "moved", message: res.ticket });
    return res.ticket;
}
