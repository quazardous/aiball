import {
    getMessage,
    getProject,
    insertMessage,
    markTicketSeen,
    moveTicket,
    insertRelationEvent,
    insertTypedRelation,
    updateMessageStatus,
    upsertTicketSubscription,
    releaseTicketClaim,
    setTicketClaim,
    ensureConsumer,
    isHuman,
    INTENTS,
    type Message,
    type NewMessage,
    type MessageKind,
    type Intent,
} from "./db.js";
import { ERROR_CODES } from "./domain.js";
import { autoApproveStaleDecisionsOnClose, rejectStaleClosedReopenedForTicket } from "./close-cleanup.js";
import { DECISION_KINDS, isDecisionKind } from "./decisions.js";
import { isHeldByOther } from "./db/assignment-gate.js";
import { assignWindowSec } from "./autopoll/config.js";
import { getConsumer } from "./db/consumers.js";
import { listSubscriptions } from "./db/subscriptions.js";
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
    // #830 — dedicated event kinds for decision transitions. Emitted
    // server-side by the /decide handler after applyDecision flips the
    // proposal's status ; agents cannot post these directly (their kind
    // is server-derived from the underlying decision). Listed here so
    // validateNewMessage accepts them on the internal submitMessage call
    // path the decide handler takes — direct API POSTs are still blocked
    // by `assertDecisionEventInternal` below.
    "plan_accepted",
    "plan_rejected",
    "resolution_accepted",
    "resolution_rejected",
    "wontfix_accepted",
    "wontfix_rejected",
    "escalation_accepted",
    "escalation_rejected",
] as const satisfies readonly MessageKind[];

// #830 — server-derived decision event kinds. Posts from external API
// callers MUST NOT carry these directly (only the /decide handler can
// emit them once the underlying meta.decision.status has flipped).
export const DECISION_EVENT_KINDS = [
    "plan_accepted",
    "plan_rejected",
    "resolution_accepted",
    "resolution_rejected",
    "wontfix_accepted",
    "wontfix_rejected",
    "escalation_accepted",
    "escalation_rejected",
] as const satisfies readonly MessageKind[];
export function isDecisionEventKind(s: string): boolean {
    return (DECISION_EVENT_KINDS as readonly string[]).includes(s);
}

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
    // #B.129 decision-on-comment + #803 decision-on-ticket : validate
    // optional `decision_kind`. Allowed on `comment_added` (original)
    // and on `ticket_created` (#803 — `ticket_new({then:"plan"})` ships
    // the plan proposal at creation time). For ticket_created only `plan`
    // makes sense — resolution/wontfix on a brand-new ticket is a smell
    // (why create then immediately propose to close?). Other kinds drop it.
    let decisionKind: string | null = null;
    if (o.decision_kind !== undefined && o.decision_kind !== null) {
        if (typeof o.decision_kind !== "string") {
            return { error: "decision_kind must be a string" };
        }
        if (!isDecisionKind(o.decision_kind)) {
            return { error: `decision_kind must be one of ${DECISION_KINDS.join(", ")}` };
        }
        if (kind !== "comment_added" && kind !== "ticket_created") {
            return { error: `decision_kind only allowed on comment_added or ticket_created (got kind=${kind})` };
        }
        if (kind === "ticket_created" && o.decision_kind !== "plan") {
            return { error: `decision_kind on ticket_created must be "plan" (got "${o.decision_kind}")` };
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
    // #697 F4 — cross-project origin. Only meaningful on ticket_created ;
    // dropped on other kinds (comments inherit the parent ticket's
    // from_project routing implicitly).
    let fromProject: string | null = null;
    if (o.from_project !== undefined && o.from_project !== null) {
        if (typeof o.from_project !== "string" || !o.from_project.trim()) {
            return { error: "from_project must be a non-empty string" };
        }
        if (kind !== "ticket_created") {
            return { error: `from_project only allowed on ticket_created (got kind=${kind})` };
        }
        if (o.from_project === o.project) {
            // Redundant — same as project means it's intra-project. Treat as
            // omitted so the column stays NULL rather than carrying a
            // misleading "cross-project" flag.
            fromProject = null;
        } else {
            fromProject = o.from_project;
        }
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
        from_project: fromProject,
    };
}

/**
 * Auto-subscribe the message author to its parent ticket. Called for every
 * inserted message regardless of moderation outcome — even if the message
 * itself is rejected later, the author has shown intent to follow the
 * thread. No-ops if by_agent is unset (anonymous post).
 */
/**
 * #669 david `96pt3m` — guard for the auto-claim on `comment_added`.
 * Returns true iff the author is allowed to silently take a fresh
 * claim on the ticket — i.e. : they have `can_claim` AND own the
 * ticket's project (role=owner subscription). Returns false (skip
 * the claim) for cross-project commenters and no-claim consumers ;
 * the comment itself still lands.
 *
 * Pure read-only check ; safe to call from inside `submitMessage`.
 * An unknown consumer (never seen before — possible during the very
 * first comment_added before `ensureConsumer` lands the row) is
 * treated as "no rights" — the auto-claim is skipped, the explicit
 * `ticket_claim` path is the path forward for them.
 */
function canAutoClaim(author: string, ticketProject: string): boolean {
    const c = getConsumer(author);
    if (!c) return false;
    if (!c.can_claim) return false;
    const subs = listSubscriptions(author);
    return subs.some((s) => s.project === ticketProject && s.role === "owner");
}

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
    (err as Error & { code?: string }).code = ERROR_CODES.FORBIDDEN_CLOSE;
    throw err;
}

/**
 * #569 (mrtroove-claude, david `j8t4qa` greenlight A+C) — proposer une
 * `resolution` ou un `plan` (=`ticket_reply then:"resolved"` / `then:"plan"`)
 * sur un ticket **encore en moderation pending** est procéduralement cassé :
 * l'agent court-circuite le flow `pending → approved → working → proposed →
 * accepted/rejected` avant que le reporter n'ait formellement validé le
 * ticket comme actionable.
 *
 * Avant ce guard, l'API acceptait sans broncher — l'agent apprenait la règle
 * par feedback humain, reproductible à chaque nouvel agent qui n'a jamais
 * fait l'erreur.
 *
 * Règle : si `kind === "comment_added"` ET `decision_kind` est posé
 * (resolution|plan), le ticket parent doit être `status === "approved"`.
 * Sinon throw `code: "PARENT_PENDING_MODERATION"` (mappé HTTP 409 côté API)
 * avec un message qui explique précisément le problème + la voie de sortie
 * (faire approuver le ticket d'abord ou poster un comment plain).
 *
 * Bypass humain : un human moderator peut court-circuiter (utile pour
 * orchestrer ticket+resolution+approve en chaîne, ou patcher d'anciens
 * threads). L'erreur ne tire que sur les agents (qui sont la cible du
 * pédagogique).
 *
 * Exempte close/reopen (qui ont leur propre `assertCloseAuthority`).
 */
function assertDecisionOnApprovedTicket(input: NewMessage): void {
    if (input.kind !== "comment_added") return;
    if (!input.decision_kind) return;
    if (!input.ticket_id) return;
    // Human moderator bypass — chaining ticket+resolution+approve en une rafale
    // est un cas légitime côté humain (orchestration manuelle, patch
    // d'anciens threads). La règle vise les agents.
    if (input.by_agent && isHuman(input.by_agent)) return;
    const parent = getMessage(input.ticket_id);
    if (!parent || parent.kind !== "ticket_created") return;
    if (parent.status === "approved") return;
    const err = new Error(
        `cannot propose ${input.decision_kind} on a ticket in status "${parent.status}" — the reporter must moderate (approve) the ticket first ; post a plain comment_added (without "then:") until then`,
    );
    (err as Error & { code?: string }).code = ERROR_CODES.PARENT_PENDING_MODERATION;
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
    assertDecisionOnApprovedTicket(input);
    // #561 : reject ticket_created on unknown project so a typo can't
    // silently birth a phantom project. Only ticket_created needs the
    // guard; comments/lifecycle inherit the parent ticket's project.
    if (input.kind === "ticket_created") {
        if (!getProject(input.project)) {
            const err = new Error(`project "${input.project}" does not exist — create it first (Projects panel or 'aiball project create')`);
            (err as { code?: string }).code = ERROR_CODES.PROJECT_NOT_FOUND;
            throw err;
        }
    }
    // Lazy-register the author so the moderator sees them in Settings >
    // Consumers and can tag kind/display_name retroactively (#B.79).
    // No-op when already present.
    if (input.by_agent) ensureConsumer(input.by_agent);
    let msg = insertMessage(input);
    autoSubscribeAuthor(msg);
    // Fan out delivery pings at INSERTION. Since #697 F3 (david `hwct2h`),
    // `fanOutPings` itself gates the subscriber / owner / follower paths
    // on `status === 'approved'`: at insertion of a pending message only
    // moderators (humans) get pinged, and the approval-time re-run (in
    // `decide` here when auto-approved, or in `api/messages.ts` when a
    // human moderates) is what wakes subscribers. `insertPing` is
    // idempotent (onConflictDoNothing on (recipient, message_id)), so the
    // double call across the pending → approved transition is a safe
    // no-op for the human pings.
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
            input.kind, // #569 — disambiguate tickets vs messages on id collision
        );
        if (updated) {
            msg = updated;
            deliverToOutbox(msg);
            fanOutPings(msg);
            // …and announce the auto-approval so subscribers transition state
            // (status: pending → approved) without polling.
            broadcast({ type: "message_decided", data: msg });
            // #568 — use `input.kind` (immutable), not `msg.kind`: when
            // tickets.id == messages.id (low counters), the legacy
            // updateMessageStatus probe flips msg.kind to "ticket_created".
            // #586 — close-time cleanup extracted to `close-cleanup.ts`.
            if (input.kind === "ticket_closed" && input.ticket_id != null) {
                const closedTicketId: number = input.ticket_id;
                autoApproveStaleDecisionsOnClose(closedTicketId, input.by_agent ?? "owner");
                rejectStaleClosedReopenedForTicket(closedTicketId, msg.id);
                // #418/#436 (révisé #568) : on relâche le claim seulement
                // (transient focus), pas l'assignment (responsabilité audit
                // qui reste pertinente sur un reopen ultérieur).
                releaseTicketClaim(closedTicketId);
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
                // #575 : never auto-claim on a pending parent ticket
                // (mirror of the explicit assign guard + #569 decision
                // guard). The rule engine can auto-approve a whitelisted
                // agent's comment while the parent stays pending.
                && t.status === "approved"
                && !isHeldByOther(t.assignee, t.claimant, t.claimed_at, author, Date.now(), assignWindowSec() * 1000)
                // #669 david `96pt3m` : auto-claim only when the
                // author has the right to claim AND owns the ticket's
                // project. A cross-project commenter (legit "file a
                // bug + hand off") used to silently end up claimant of
                // the target project's thread — pisynth-claude got
                // auto-claimed on aiball #669 after just commenting.
                // Guard : skip when can_claim=false OR the author
                // isn't subscribed as `owner` on the ticket's project.
                && canAutoClaim(author, t.project)) {
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
    // #837 — auto-prune unread on the author : an agent who POSTS on a ticket
    // has by definition read the prior context, so their own unread pings on
    // that ticket are stale by construction. `markTicketSeen` is consumer-
    // scoped — other recipients keep their unread. Without this guard, david's
    // wake-stuck unblock-cascade (#751-followups, e1660f8) replayed every
    // historical comment on tickets where I'd already replied N times.
    if (msg.by_agent && msg.ticket_id != null) {
        try { markTicketSeen(msg.by_agent, msg.ticket_id); }
        catch { /* best-effort — pings table errors must not fail the message insert */ }
    }
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
    // #509 — `old_project` plumb pour que ticket_project_changed automation
    // (runtime.ts) ait l'avant + l'après. `res.from` est le project SOURCE.
    emitLifecycle({ op: "moved", message: res.ticket, old_project: res.from });
    return res.ticket;
}
