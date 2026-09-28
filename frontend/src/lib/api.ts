import type { DecisionKind } from "@shared/ticket-transitions";
import type { WaitCreditMove, WaitCreditRow } from "./waitCredit";
import { withBase } from "./base";
import { Rpc, type RpcSubscribeOptions } from "./rpc";

export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

/**
 * Merged tag-catalog row (#223) returned by `GET /tags?project=`. Config
 * tags come from the yaml chain — read-only, non-deletable, `id: null`,
 * `source: "config"`; DB tags carry their real id and `source: "db"`.
 */
export interface CatalogTag {
    id: number | null;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string | null;
    source: "config" | "db";
    /** Config tags only: the config-default color an override diverges from (#223 zcjqgp). */
    config_color?: string | null;
    /** Config tags only: true when a DB row overrides the config color. */
    color_overridden?: boolean;
    /** #554 — `null` = global tag / config row ; project name = scoped to that project. */
    project?: string | null;
}

// Business enums are centralised in `./domain.ts` (#B.122). Re-export
// them here so existing consumers that import from `./api` still work.
export {
    MESSAGE_KINDS,
    MESSAGE_STATUSES,
    INTENTS,
    PRIORITIES,
    STRATEGIES,
    isMessageKind,
    isMessageStatus,
    isIntent,
    isPriority,
    isStrategy,
} from "./domain";
export type { MessageKind, MessageStatus, Intent, Priority, Strategy } from "./domain";
import type { MessageKind, MessageStatus, Intent, Priority, Strategy } from "./domain";

export interface Message {
    id: number;
    project: string;
    kind: MessageKind;
    ticket_id: number | null;
    parent_id: number | null;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    status: MessageStatus;
    created_at: string;
    decided_at: string | null;
    decided_by: string | null;
    matched_rule_id: number | null;
    human_note: string | null;
    intent: Intent | null;
    /** Per-ticket urgency hint (#B.222). Tickets only; defaults to
     *  "normal" at the SQL layer if absent. Comments and lifecycle
     *  events omit this field on the wire. */
    priority?: Priority;
    /** #2216 — tickets only. */
    level?: "task" | "milestone" | "roadmap";
    /** Public ref for comments / lifecycle events. NULL for tickets. */
    hashid?: string | null;
    /** Set on `ticket_sub_added` / `ticket_referenced` pseudo-comments —
     *  the source ticket that triggered the relation event. */
    source_ticket_id?: number | null;
    /** Lifecycle stage of the source ticket, populated server-side for
     *  ticket_referenced / ticket_sub_added rows so the UI can render a
     *  small "where is this relation pointing now?" badge. */
    source_ticket_stage?: TicketStage;
    /** #2432 — the other ticket's title, for the row's tooltip. */
    source_ticket_title?: string | null;
    /** Sidecar JSON (raw string from the DB). Carries question audit
     *  (#B.104) and decision-on-comment (#B.129). Parsed lazily by
     *  components that need it. */
    meta?: string | null;
    /** #B.245 event scope tristate. `internal` = owners+@mentions
     *  only; `default` = subscribers+owners+@mentions; `broadcast` =
     *  + followers. Drives the per-card scope picto. */
    scope?: "internal" | "default" | "broadcast";
    tags: Tag[];
    /** #518 — agrégé pour les comments uniquement. `mine` est calculé
     *  côté serveur pour le viewer du request. Optionnel : un payload
     *  antérieur (broadcast cross-user) peut ne pas l'avoir, et on
     *  recompute alors localement à partir de `meta.votes`. */
    votes_summary?: { up: number; down: number; mine: 1 | -1 | null };
}

export type TicketStage =
    | "rejected"
    | "closed-resolved"
    | "closed"
    | "resolved"
    | "blocked"
    | "snoozed"
    | "pending"
    | "open";

/** #457 — unified automation rule (slice 4). Server returns a `triggers`
 *  JSON-decoded list and a typed `action` discriminated union. */
export type AutomationTrigger =
    | "message_posted"
    | "actionable_eval"
    | "ticket_created"
    | "ticket_tagged"
    | "ticket_priority_changed"
    | "ticket_project_changed"
    | "ticket_status_changed";
export type AutomationAction =
    | { kind: "assign"; consumer_id: string }
    | { kind: "decision"; decision: "auto" | "review" }
    | { kind: "pickup"; mode: "only" | "except" }
    | { kind: "add_tag"; tag: string }
    | { kind: "set_priority"; priority: "urgent" | "high" | "normal" | "low" }
    | { kind: "notify"; consumer_id: string };
/** #457 slice 5.1 — compositional condition tree (mirror of the backend's
 *  src/db/automation.ts::ConditionTree). Recursive shape : a node is either
 *  a leaf (field+op+value), or a combinator AND/OR with N children, or NOT
 *  with one child. */
export type ConditionField =
    | "project"
    | "kind"
    | "by_agent"
    | "intent"
    | "priority"
    | "tag_added"
    | "tags"
    | "scope_consumer"
    | "status";
export type ConditionOp = "eq" | "neq" | "in" | "includes";
export type ConditionTree =
    | { kind: "and"; children: ConditionTree[] }
    | { kind: "or"; children: ConditionTree[] }
    | { kind: "not"; child: ConditionTree }
    | { kind: "leaf"; field: ConditionField; op: ConditionOp; value: unknown };
export interface AutomationRule {
    id: number;
    triggers: AutomationTrigger[];
    scope_consumer: string | null;
    match_project: string | null;
    match_kind: string | null;
    match_by_agent: string | null;
    match_tags: string[];
    match_tag_added: string | null;
    match_intent: string | null;
    match_priority: string | null;
    /** Slice 5.4 — back-compat read of the FIRST action in `actions`. Old
     *  callers that only knew about a single action keep working ; new UI
     *  code (slice 5.3b) reads `actions` for the full stack. */
    action: AutomationAction;
    enabled: 0 | 1;
    position: number;
    note: string | null;
    created_at: string;
    /** Slice 5.1 — canonical condition tree (server synthesizes one for
     *  legacy rows pre-slice-5 so this is always populated). */
    expression: ConditionTree;
    /** Slice 5.4 — stack of actions executed sequentially on a rule match
     *  (david `aa48pd`). Server-side guarantees ≥1 entry (legacy single
     *  `action` wraps to `[action]`). New UI binds against this. */
    actions: AutomationAction[];
}

/** #447: a per-agent work filter — narrows which tickets a consumer picks up,
 *  by tag. Applied server-side in the actionable/claimable gate. */
/** #449: one schema key resolved for the config-manager UI — meta + each layer
 *  (global/project override) + the effective value. Mirrors the backend's
 *  ResolvedConfig. `value`/layers are string|number|boolean per the key's type. */
export type ConfigPrimitive = string | number | boolean;
export interface ManagedConfigRow {
    key: string;
    scope: "global" | "global+project" | "project";
    /** #3138 — `duration`: seconds, written in the notation (`1h30m`). */
    type: "string" | "number" | "boolean" | "enum" | "duration";
    options: string[] | null;
    /** #3147 — where it can be set: `db` (this page, `config.set`) and/or `file` (`.aiball.yaml`). */
    sources: ("db" | "file")[];
    protected: boolean;
    label: string;
    description: string;
    default: ConfigPrimitive;
    /** global-layer override, or null when unset. */
    global: ConfigPrimitive | null;
    /** project-layer override (when a project is in scope), or null. */
    project: ConfigPrimitive | null;
    /** effective value after layering. */
    value: ConfigPrimitive;
}

/**
 * The current consumer (the human moderator behind the UI). Stored in
 * localStorage and propagated to the backend on EVERY request via the
 * `X-Aiball-Consumer` header — that way per-consumer fields like the
 * `unread` flag in /api/inbox and the scope of mark-read/mark-unread are
 * resolved server-side without each call having to pass an explicit
 * consumer id.
 */
function currentConsumer(): string {
    return localStorage.getItem("aiball.human_id") ?? "human";
}

/** Stored auth token (#B.94). Set by Setup / Login, cleared by Logout. */
function currentToken(): string | null {
    return localStorage.getItem("aiball.token");
}

export function setAuthToken(token: string): void {
    localStorage.setItem("aiball.token", token);
}

export function clearAuthToken(): void {
    localStorage.removeItem("aiball.token");
}

/**
 * Global 401 handler — called by `req()` when the daemon rejects the
 * token. App.vue installs the real callback; the default just clears
 * the token so a refresh sends us to the login screen.
 */
let onUnauthorized: () => void = () => {
    clearAuthToken();
    if (location.pathname !== "/login" && location.pathname !== "/setup") {
        location.href = "/login";
    }
};
export function setUnauthorizedHandler(fn: () => void): void {
    onUnauthorized = fn;
}

/**
 * The shared core: auth, base path, error handling. Returns the Response so a
 * caller that needs a HEADER can read one — #2071's pager needs the total row
 * count, which cannot travel in a body that must stay a plain array for every
 * other consumer.
 */
async function rawReq(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
        "x-aiball-consumer": currentConsumer(),
    };
    if (body) headers["content-type"] = "application/json";
    const tok = currentToken();
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    // #190 — prefix the configured base path (e.g. /aiball) so the request
    // lands on the right tailscale --set-path mount, not host root.
    const res = await fetch(withBase(path), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        // Token expired / never set — bail to the login screen.
        onUnauthorized();
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return res;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await rawReq(method, path, body);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

/**
 * #3068 — the bus connection the calls below go through (docs/API-BUS.md). Its
 * identity is the token's; the `x-aiball-consumer` header HTTP sends is the
 * same consumer (`aiball.human_id` is set from it at setup).
 */
const rpc = new Rpc({ onUnauthorized: () => onUnauthorized() });
if (typeof document !== "undefined") {
    // A tab back in view reconnects at once rather than after its backoff.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") rpc.wake();
    });
}

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return rpc.call<T>(method, params);
}

/** #3068 — subscribe to a bus subject on the page's one connection; kept across reconnections. */
export function subscribeBus(subject: string, onEvent: (data: unknown, subject: string) => void, opts: RpcSubscribeOptions = {}): { close(): void } {
    return rpc.subscribe(subject, onEvent, opts);
}

/** #2074 — state of the enrolment switch. */
export interface PairingWindow {
    open: boolean;
    /** The deadline. Count down from THIS rather than from `seconds_left`,
     *  which is only true at the instant the response was built. */
    open_until: string | null;
    seconds_left: number;
    opened_by: string | null;
    /** What "open" opens it for, in seconds — the server owns the duration. */
    default_seconds: number;
}

/**
 * #2074 — a proxy node's pairing request. Never carries the token: that is
 * minted at approval and collected by the node itself, once.
 */
export interface NodeEnrollment {
    id: string;
    /** Compared against the code printed on the node — that comparison is what
     *  ties this row to the machine in front of you. */
    code: string;
    /** What the node calls itself. Chosen by the asker, so a hint, not proof. */
    label: string | null;
    /** Where it came from — the one thing the hub observed rather than was told. */
    requested_ip: string | null;
    /** #2081 — what the machine says it is called, resolved on its own side the
     *  way a paired node does. A claim like the label, never evidence. */
    claimed_host: string | null;
    claimed_host_provider: string | null;
    created_at: string;
    expires_at: string;
    state: "pending" | "approved" | "rejected" | "delivered" | "expired";
    decided_at: string | null;
    decided_by: string | null;
}

/**
 * #2112 — a payload zone as every surface sees it: keys always, values only
 * where the schema declared them public.
 *
 * A secret value arrives as `{secret: true, preview}` rather than as its own
 * text — `preview` is a short fixed prefix, or null when the value was too
 * short for even that to be discreet. The raw values never reach the browser.
 */
export interface RedactedValue {
    secret: true;
    preview: string | null;
}

export interface PayloadView {
    ticket_id: number;
    /** The key names declared PUBLIC. Empty means every key is secret. */
    schema: string[];
    /** Every key, visible even when the values are not — an unreadable payload
     *  must still be an auditable one. After revocation these come from the
     *  tombstone, so the row still says WHICH credential was destroyed. */
    keys: string[];
    payload: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    by_agent: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
    /** `open` — readable. `ticket-closed` — out of reach until reopened.
     *  `revoked` — the values are gone for good. */
    access?: "open" | "ticket-closed" | "revoked";
}

/** #2910 — a milestone as a ticket row names it; closed = released. */
export interface MilestoneRef {
    id: number;
    title: string;
    released: boolean;
}

export interface MilestoneRow extends MilestoneRef {
    released_at: string | null;
    created_at: string;
    done: number;
    open: number;
}

export interface TicketSummary {
    id: number;
    project: string;
    /**
     * #2070 — the project this ticket was filed FROM, when its author does not
     * belong to `project`. Null for an ordinary intra-project ticket, and null
     * too whenever the origin is ambiguous: a wrong "from X" sends the reader
     * after a relationship that does not exist.
     */
    from_project?: string | null;
    title: string | null;
    /** Agent-authored one-line summary (#B.87). Falls back to title. */
    summary?: string | null;
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: MessageStatus;
    closed: boolean;
    resolved?: boolean;
    resolved_by?: string | null;
    resolved_at?: string | null;
    /** Agent signalled "I'm stuck, your call" (#B.119). */
    blocked?: boolean;
    blocked_by?: string | null;
    blocked_at?: string | null;
    /** #B.245 tristate scope. */
    scope?: "internal" | "default" | "broadcast";
    /** Snooze (#B.329) — when set and in the future, the ticket is
     *  hidden from the open inbox until that timestamp. */
    postponed_until?: string | null;
    intent: Intent | null;
    /** Urgency hint (#B.222). Defaults to "normal" server-side. */
    priority?: Priority;
    /** #2216 — tickets only. */
    level?: "task" | "milestone" | "roadmap";
    /** Parent ticket id when this ticket is a sub-ticket. Rendered as
     *  "Sub-ticket of #B.NN" metadata in the thread header. */
    parent_ticket_id?: number | null;
    /** Direct children of this ticket (sub-tickets). Empty when none.
     *  Rendered as a recap in the parent's thread header. */
    sub_tickets?: SubTicketSummary[];
    /** Typed inter-ticket relations (#B.123 phase B). Active set after
     *  replay — already filtered for `kind=ignored` tombstones. Only
     *  surfaced when the GET asked for `full=1`. */
    relations?: TicketRelation[];
    tags: Tag[];
    /** #404: accumulated per-ticket token-effort tally (null until any usage
     *  is captured). Raw counts; derive a cost estimate via `estTokenCost`. */
    token_usage?: TokenUsage | null;
    /** #405: in the requesting consumer's hot-zone (focus) — the ticket they're
     *  actively working (most recent self-activity within the hot window). */
    hot?: boolean;
    /** #418/#436: two distinct holds. ASSIGNMENT (`assignee`/`assigned_by`/
     *  `assigned_at`) = a responsibility a human pushed (persistent). CLAIM
     *  (`claimant`/`claimed_at`) = an agent's current focus (transient). A ticket
     *  can carry both. `is_claim` kept for back-compat (true when claimed). */
    assignee?: string | null;
    assigned_by?: string | null;
    assigned_at?: string | null;
    claimant?: string | null;
    claimed_at?: string | null;
    is_claim?: boolean;
    /** #596 — per-consumer: ≥1 unseen ping on this thread for the
     *  requesting consumer. Lets the UI skip the "marking-as-read"
     *  pulse when landing on an already-read ticket. */
    unread?: boolean;
    /** #803 — sidecar JSON metadata (same shape as Message.meta). Today
     *  carries the `decision` block when the ticket was created via
     *  `ticket_new({then:"plan"})`. Stringified JSON, parsed via
     *  `readDecision(ticket)` like a decision-bearing comment. */
    meta?: string | null;
    /** #803 — per-consumer flag : true iff this ticket has a pending
     *  plan/resolution decision currently gating it out of the actionable
     *  backlog. */
    decision_proposable?: boolean;
    gated_by_decision?: boolean;
    /** #2112 — true iff the ticket carries a payload zone. Says only that one
     *  exists, never anything about its contents. The UI mounts the payload
     *  panel ONLY on this, so a ticket without one costs no request at all. */
    has_payload?: boolean;
    /** #2770 — set on the project's critical ticket: the open ticket holding
     *  back the most open tickets. */
    critical?: { holds: number; quiet: string } | null;
    /** #2910 — the milestone (a ticket of level `milestone`) this ticket belongs to. */
    milestone?: MilestoneRef | null;
    /** #2910 — on a milestone ticket: its tickets, done and open. */
    milestone_progress?: { done: number; open: number; tickets: { id: number; title: string; closed: boolean }[] };
    /** #1542 — upstream coupling. Set only when the ticket is coupled to an
     *  external issue (manual import/export). All null = a pure aiball ticket. */
    upstream_kind?: string | null;
    upstream_ref?: string | null;
    upstream_num?: number | null;
    upstream_synced_at?: string | null;
}

/** #404: per-ticket token-effort tally (raw counts from the Claude transcript). */
export interface TokenUsage {
    tokens_in: number;
    tokens_out: number;
    cache_w: number;
    cache_r: number;
    updated_at: string;
}

/** #2180 — a pending child of a ticket, with who attached it and when. */
export interface PendingChild {
    ticket_id: number;
    project: string;
    title: string;
    reporter: string | null;
    attached_by: string | null;
    attached_at: string;
}

export interface TicketRelation {
    target_ticket_id: number;
    kind: import("./relations").RelationKind;
    last_event_id: number;
    last_event_at: string;
    by_agent: string | null;
    /** #B.123 follow-up: target's current lifecycle stage so the chip
     *  can render a state badge (open / closed / closed-resolved /
     *  rejected). Enriched server-side; backfill defaults to "open"
     *  when the stage isn't known. */
    target_stage?: TicketStage;
    /** #2432 — the target ticket's title, for the chip's tooltip. */
    target_title?: string | null;
    /** #B.197: true when this chip is the inverse view of an event
     *  authored on the OTHER ticket (e.g. "#196 blocks #189" shows
     *  on #189 as `depends_on #196` with reciprocal=true). Frontend
     *  renders these visually distinct so the audit trail stays
     *  readable. */
    reciprocal?: boolean;
}

export interface SubTicketSummary {
    id: number;
    title: string;
    status: MessageStatus;
    closed: boolean;
    stage: TicketStage;
}

export interface SearchHit {
    kind: "ticket" | "comment";
    id: number;
    ticket_id: number;
    project: string;
    title: string | null;
    hashid: string | null;
    by_agent: string | null;
    created_at: string;
    status: MessageStatus;
    /** HTML snippet with `<mark>…</mark>` around matched terms. */
    snippet: string;
    rank: number;
}

export interface InboxRow {
    id: number;
    project: string;
    title: string | null;
    /** Agent-authored one-line summary (#B.87). Shown under the title. */
    summary?: string | null;
    /** #1161 S1 — server-side 140-char snippet (full bodies no longer ship
     *  on list rows ; fetch the ticket for the body). */
    snippet: string | null;
    by_agent: string | null;
    created_at: string;
    status: MessageStatus;
    intent: Intent | null;
    /** Urgency hint (#B.222). Defaults to "normal" server-side. */
    priority?: Priority;
    /** #2216 — tickets only. */
    level?: "task" | "milestone" | "roadmap";
    closed: boolean;
    resolved?: boolean;
    /** Agent signalled "I'm stuck, your call" (#B.119). */
    blocked?: boolean;
    /** Some agent has proposed this ticket as resolved, awaiting reporter's accept/reject. */
    pending_resolution?: boolean;
    /** #656 david: symmetric to pending_resolution — an agent has
     *  proposed a PLAN (HOW choice) and the reporter still has to
     *  accept/reject. Surfaced so the inbox row can flag pending
     *  plans the same way it flags pending resolutions. */
    pending_plan?: boolean;
    /** #737: an agent flagged this ticket for human action it can't
     *  perform (repo admin / infra / policy decision). Surfaced so the
     *  inbox row paints a red ESCALATED badge. Cleared once the ticket
     *  is closed/rejected. */
    pending_escalation?: boolean;
    /** #1835 — pending wontfix (close without resolution), awaiting the
     *  reporter. Same green attention band as plan / resolution. */
    pending_wontfix?: boolean;
    /** #2308 — a step (then: continue) nothing has followed for
     *  tickets.steps.stale: the work it announced went quiet. */
    stalled_step?: boolean;
    /** #2327 — the last word on the ticket is a step (then: continue). */
    latest_is_step?: boolean;
    /** #2456 — when the latest step's agent resumes (ISO); null = at once. */
    step_resume_at?: string | null;
    /** #656 david `2c9qm4`: true iff a pending decision exists AND
     *  the decision-bearing comment IS the latest comment on the
     *  thread (no newer activity past it). UI uses this to keep
     *  the attention band solid for "fresh proposal" vs dashed for
     *  "proposal hanging while conversation continued". */
    pending_decision_is_latest?: boolean;
    /** #B.168 follow-up: the LATEST resolution decision on this
     *  ticket was rejected — UI shows a `× rejected` badge so the
     *  reporter sees "I rejected, the thread is still open". */
    latest_resolution_rejected?: boolean;
    /** #B.173: same for plan decisions — the latest plan was
     *  rejected. UI surfaces this so the list shows that an
     *  agent's plan was knocked back and the thread stays open
     *  pending a new direction. */
    latest_plan_rejected?: boolean;
    /** #B.245 tristate scope. */
    scope?: "internal" | "default" | "broadcast";
    /** Per-consumer flag: ≥1 unseen ping on the thread for the requesting consumer. */
    unread?: boolean;
    /** #2112 — the ticket carries a payload zone. Drives a discreet mark in
     *  the list; absent on the overwhelming majority of rows, by design. */
    has_payload?: boolean;
    /** #2770 — set on the project's critical ticket. */
    critical?: { holds: number; quiet: string } | null;
    /** #2910 — the milestone this ticket belongs to. */
    milestone?: MilestoneRef | null;
    /** #405: in the requesting consumer's hot-zone (focus) — the ticket they're
     *  actively working. Drives the 🔥 flag in the inbox list. */
    hot?: boolean;
    /** Snooze flag (#B.329): true iff `postponed_until` is in the future.
     *  Postponed rows are hidden from the open inbox the same way closed
     *  ones are. */
    postponed?: boolean;
    postponed_until?: string | null;
    comment_count: number;
    pending_comment_count: number;
    last_activity: string;
    /** #B.132 — `by_agent` of the most recent approved comment on the
     *  thread (or the ticket creator if no comments yet). UI shows a
     *  discrete "you" marker when this matches the current consumer
     *  so the user remembers who spoke last without opening the thread. */
    last_speaker?: string | null;
    tags: Tag[];
    /** #427: accumulated per-ticket token-effort tally (null until any usage
     *  is captured). Raw counts; derive a cost estimate via `estTokenCost`. */
    token_usage?: TokenUsage | null;
    /** #429: who currently holds this ticket — surfaced so the list can render
     *  a compact claim/assign icon + tooltip naming the holder (parity with the
     *  thread header). Two distinct holds (#418/#436): CLAIM (`claimant`/
     *  `claimed_at`, an agent's transient focus) and ASSIGNMENT (`assignee`/
     *  `assigned_at`, a human-pushed responsibility). A row can carry both. */
    claimant?: string | null;
    claimed_at?: string | null;
    assignee?: string | null;
    assigned_at?: string | null;
}

export interface ThreadView {
    ticket: TicketSummary;
    comments: Message[];
    /**
     * Set when the URL or query asked for a message id that wasn't a ticket
     * (e.g. a comment): the API resolved up to the parent thread and tells
     * the UI which message to scroll to.
     */
    focus_message_id?: number | null;
}

export interface PostMessageInput {
    project: string;
    kind: MessageKind;
    title?: string;
    body?: string;
    ticket_id?: number;
    parent_id?: number;
    intent?: Intent | null;
    /** #B.222 urgency hint (ticket_created only; defaults to "normal"). */
    priority?: Priority;
    /** #2216 — tickets only. #3037 — honoured at creation (a level other than
     *  `task` by a human moderator), with the other extras below. */
    level?: "task" | "milestone" | "roadmap";
    /** #3037 — a new ticket's extras, checked and applied in the same call:
     *  a refusal refuses the whole ticket. Tags by id or by name. */
    tags?: (number | string)[];
    assignee?: string;
    milestone?: number;
    /** #B.129 — tag a message as a decision proposal at post-time. The
     *  server checks the kind against where it may sit (the transition table). */
    decision_kind?: DecisionKind;
}

/** Consumer registry entry (#B.79). */
export type ConsumerKind = "human" | "agent" | "sandbox";

export const CONSUMER_KIND_OPTIONS: { label: string; value: ConsumerKind }[] = [
    { label: "Human", value: "human" },
    { label: "Agent", value: "agent" },
    { label: "Sandbox", value: "sandbox" },
];
/** Claude-loop state pushed by the timer (#B.177 B1). */
export type ConsumerState = "boot" | "idle" | "busy";
export interface TokenSnapshotRow {
    project: string;
    captured_at: string;
    tokens_in: number;
    tokens_out: number;
    cache_w: number;
    cache_r: number;
}

export interface Consumer {
    consumer_id: string;
    kind: ConsumerKind;
    display_name: string | null;
    enabled: boolean;
    note: string | null;
    /** #397: per-consumer micro-prompt — a short standing instruction edited
     *  here, injected into the wake prompt via the `{consumer_prompt}`
     *  placeholder. null = none (opt-in). */
    micro_prompt?: string | null;
    /** #508 — global flag : peut claim normalement (true, défaut) ou
     *  consumer "spécialiste" (false) qui ne prend QUE les tickets explicitement
     *  assignés via ticket_assign. */
    can_claim?: boolean;
    /** #1435 slice 7 — lead capability: true = may provision/launch crew
     *  agents. Default false. Human-granted only. */
    can_create_agent?: boolean;
    /** #2201 — which MCP tools the agent is shown. */
    agent_type?: "coder" | "cto";
    /** #1435 slice 5 — multi-agent role (lead / crew / null), set from the
     *  agent's launch role. Shown as a badge in the consumers panel. */
    role?: string | null;
    /** #516 — tri-state opt-in pour broadcasts projet. null = auto (suit
     *  can_claim) ; true = opt-in explicite ; false = opt-out explicite. */
    notify_project_broadcasts?: boolean | null;
    /** #B.177: ISO8601 of last API call from this consumer. */
    last_seen_at?: string | null;
    /** #1185 — raw ping tally from the DB : total rows + still-unseen. */
    ping_count?: number;
    ping_unseen?: number;
    /** #2645 — wait credit per project; null for a human, [] before any movement. */
    wait_credit?: WaitCreditRow[] | null;
    /** #B.177 B1: current claude-loop state (null = no loop tracking). */
    state?: ConsumerState | null;
    /** #B.177 B1: ISO8601 of when current state was entered. */
    state_since?: string | null;
    /**
     * #B.177 B1: ISO8601 of last heartbeat. UI computes "offline"
     * when `now - state_updated_at` exceeds the offline threshold.
     */
    state_updated_at?: string | null;
    /**
     * #443: live-presence verdict from the daemon's in-memory SSE registry
     * (#395). `true` = a live (or within-grace) SSE connection → running NOW;
     * `false` = seen-then-gone this session → authoritatively stopped (overrides
     * a still-fresh heartbeat — a killed loop reads offline ~immediately);
     * `null`/undefined = never seen via SSE this session (e.g. right after a
     * daemon restart) → fall back to the `state_updated_at` heartbeat window.
     */
    present?: boolean | null;
    /**
     * #280: live human-presence at the last heartbeat — true when a human
     * is driving the loop (typing / within user-grace). null = never
     * reported. Drives the `human` vs `loop` badge.
     */
    state_human?: boolean | null;
    /**
     * #310: 3-state human-presence word (stop/wait/loop) at the last
     * heartbeat — mirrors the tmux bar's presence chip. null = never reported
     * / pre-#310 loop (fall back to `state_human` for the binary view).
     */
    state_human_word?: "stop" | "wait" | "boot" | "loop" | null;
    /** #393: the loop's working directory (project root), pushed by the state
     *  heartbeat. null for humans / non-loop / pre-#393 loops. */
    cwd?: string | null;
    /** #422: transport last seen on — `uds` / `tcp` / `node`. null = untracked. */
    last_seen_via?: "uds" | "tcp" | "node" | string | null;
    last_seen_ip?: string | null;
    /** #422: derived — remote consumer (node-relayed, or TCP from a non-loopback
     *  peer). Drives a "remote" badge in the consumers panel. */
    remote?: boolean;
    created_at: string;
    updated_at: string;
}

export interface ProjectMeta {
    name: string;
    last_activity: string;
    ticket_count: number;
    comment_count: number;
    pending_count: number;
    /** Set when listProjectsDetailed is called with a consumer_id. */
    unread_for_consumer?: number;
    /** Approved tickets currently open (not closed, not snoozed). */
    open_count?: number;
    /** Approved tickets currently snoozed (postponed_until > now). */
    snoozed_count?: number;
    /** Approved+open tickets currently in the resolved-pending-close state. */
    resolved_count?: number;
    /** #393: a claude-loop with a known root has worked this project → it's
     *  "local" (root known, can be relaunched from the UI). */
    local?: boolean;
    /** #393: the distinct loop root(s) known for this project (consumers.cwd). */
    roots?: string[];
    /** #393 (3c): a claude-loop is **currently running** for this project (a
     *  rooted consumer heartbeated recently). Distinct from `local`. */
    running?: boolean;
    /** #395 (q3bfvn): the running loop's activity state (busy/idle/boot). */
    running_state?: "busy" | "idle" | "boot" | string;
    /** #395 (q3bfvn): a live human is driving the running loop (#280). */
    running_human?: boolean;
    /** #395 (q3bfvn): the running loop's presence word (stop/wait/loop, #310). */
    running_human_word?: "stop" | "wait" | "loop" | string;
    /** #406 (david chhv9c): cumulative per-project token-effort tally (raw
     *  counts summed across the project's tickets; null until any usage). The
     *  Projects list shows a derived cost via `estTokenCost`. */
    token_usage?: TokenUsage | null;
}

/** #398: an operator-approved command launcher (declared in config). */
export interface Launcher {
    id: string;
    label: string;
    cmd: string;
    args?: string[];
    cwd?: string;
    icon?: string;
}

/** #2525 — the standing instruction and the wake focus of a project. */
export interface StandingPromptView {
    project: string;
    standing_prompt: string | null;
    focus_tickets?: string | null;
    focus_until?: string | null;
    focus_active?: boolean;
    focus_line?: string;
}

export const api = {
    listProjects: () => call<string[]>("project.list"),
    /** #1200 — token-usage-over-time series (per project snapshots). */
    tokenTimeseries: (opts: { project?: string; days?: number } = {}) => {
        return call<{ series: TokenSnapshotRow[] }>("token_usage.timeseries", { project: opts.project || undefined, days: opts.days || undefined });
    },
    /**
     * Explicitly register a project (#B.216 phase A pass 2). 409 means
     * the name already exists; 400 means empty/whitespace name.
     */
    createProject: (
        name: string,
        opts: { display_name?: string; description?: string; created_by?: string } = {},
    ) =>
        call<{
            name: string;
            display_name: string | null;
            description: string | null;
            created_at: string;
            created_by: string | null;
        }>("project.create", { name, ...opts }),
    listProjectsDetailed: (consumer_id?: string) =>
        call<ProjectMeta[]>("project.list", { detailed: true, consumer_id }),
    deleteProject: (name: string) =>
        call<{ project: string; deleted_messages: number; ok: boolean }>("project.delete", { name }),
    purgeOldClosed: (name: string, older_than_days = 365) =>
        call<{
            project: string;
            older_than_days: number;
            purged_tickets: number;
            purged_messages: number;
            ok: boolean;
        }>("project.purge", { name, older_than_days }),
    // #475 david : global "Purge tickets closed > 1 year" depuis la Danger
    // zone de Settings > General. Boucle server-side sur listProjects().
    purgeAllOldClosed: (older_than_days = 365) =>
        call<{
            older_than_days: number;
            purged_tickets: number;
            purged_messages: number;
            per_project: { project: string; purged_tickets: number; purged_messages: number }[];
            ok: boolean;
        }>("board.purge", { older_than_days }),
    // #476 david : "ajout d'un zone information global — avec la taille des
    // data / image etc les infos etc". Daemon-wide info zone (version, db
    // size, uploads size, totals) rendered in Settings > General.
    getInfo: () =>
        call<{
            version: string;
            uptime_sec: number;
            home: string;
            db: { path: string; bytes: number };
            uploads: { path: string; bytes: number; files: number };
            counts: {
                projects: number;
                tickets_total: number;
                tickets_open: number;
                tickets_closed: number;
                messages: number;
            };
            ts: string;
        }>("board.info"),
    projectStatsRich: (name: string) =>
        call<unknown>("project.stats_rich", { name }),
    // Per-project strategy override (#B.127). `strategy: null` in the
    // response = no override, the project follows the global strategy.
    getProjectStrategy: (name: string) =>
        call<{ project: string; strategy: Strategy | null; global: Strategy }>("project.strategy", { project: name }),
    setProjectStrategy: (name: string, strategy: Strategy | null) =>
        call<{ project: string; strategy: Strategy | null; global: Strategy }>("project.set_strategy", { project: name, strategy }),
    getProjectStandingPrompt: (name: string) =>
        call<StandingPromptView>("project.standing_prompt", { project: name }),
    /** #2525 — the wake focus, beside the standing instruction. */
    setProjectWakeFocus: (name: string, focus_tickets: string | null, focus_until: string | null) =>
        call<StandingPromptView>("project.set_standing_prompt", { project: name, focus_tickets, focus_until }),
    setProjectStandingPrompt: (name: string, standing_prompt: string | null) =>
        call<{ project: string; standing_prompt: string | null }>("project.set_standing_prompt", { project: name, standing_prompt }),
    mentionSuggestions: () =>
        call<{ projects: string[]; agents: string[] }>("mention.suggestions"),
    listMessages: (params: {
        status?: string;
        project?: string;
        kind?: string;
        limit?: number;
    } = {}) => call<Message[]>("message.list", { ...params, status: params.status || undefined, project: params.project || undefined, kind: params.kind || undefined }),
    listTickets: (params: { project?: string; open?: boolean } = {}) =>
        call<TicketSummary[]>("ticket.list", {
            ...(params.project ? { project: params.project } : {}),
            ...(params.open ? { open: true } : {}),
        }),
    /**
     * #2071 — one page of the inbox, filtered and sorted BY THE SERVER.
     *
     * It used to fetch the whole board and slice client-side, which was fine
     * when the comment justifying it was written ("~63 rows total today") and
     * had quietly become 2071 rows and 2.26 MB to display 25. Returns the page
     * plus the total, the latter read from a header so the body stays a plain
     * array for every other consumer.
     */
    inbox: async (
        params: {
            project?: string;
            status?: string;
            open?: boolean;
            intent?: string;
            priority?: Priority;
    /** #2216 — tickets only. */
    level?: "task" | "milestone" | "roadmap";
            include_postponed?: boolean;
            unread?: boolean;
            sort?: string;
            limit?: number;
            offset?: number;
            /** #2072 — narrow to specific tickets, to refresh ONE row (~1 KB)
             *  instead of a page. An id that comes back missing no longer
             *  belongs in this view, which is how a cache learns to drop it. */
            ids?: number[];
        } = {},
    ): Promise<{ rows: InboxRow[]; total: number }> => {
        // The page size is the reader's own preference, not a constant — so it
        // travels with the request rather than living in the endpoint.
        const out = await call<{ rows: InboxRow[]; total: number }>("inbox.list", {
            project: params.project || undefined,
            status: params.status || undefined,
            open: params.open || undefined,
            intent: params.intent || undefined,
            priority: params.priority || undefined,
            include_postponed: params.include_postponed || undefined,
            unread: params.unread || undefined,
            sort: params.sort || undefined,
            limit: params.limit || undefined,
            offset: params.offset || undefined,
            ids: params.ids?.length ? params.ids : undefined,
        });
        return { rows: out.rows, total: Number.isFinite(out.total) ? out.total : out.rows.length };
    },
    markTicketRead: (id: number, upToId?: number) =>
        call<{ ticket_id: number; updated: number; up_to_id?: number }>(
            "ticket.mark_read",
            typeof upToId === "number" ? { id, up_to_id: upToId } : { id },
        ),
    markTicketUnread: (id: number) =>
        call<{ ticket_id: number; updated: number }>("ticket.mark_unread", { id }),
    // The UI always needs the full thread (body + comments) — the
    // summary default that landed in 0.5.x (#B.87) targets agents, not
    // the moderator browser. Force full=1.
    // #309: include_deleted=1 surfaces user-deleted comments as tombstones in
    // the moderator UI (agents/MCP never pass it, so they don't see them).
    getTicket: (id: number) => call<ThreadView>("ticket.get", { id, full: true, include_deleted: true }),
    /** A ticket's header alone (by id or hashid): where it lives, for jumping to it. */
    getTicketHeader: (id: number | string) => call<{ ticket: { id: number; project: string } }>("ticket.get", { id }),
    /** #3258 — the header alone (no thread): a link's tooltip needs the title only. */
    getTicketTitle: (id: number) => call<{ ticket: { id: number; title: string } }>("ticket.get", { id }),
    /** #235 — the board's configuration: formatting patterns and upstream bindings. */
    getConfig: () => call<{ formatting?: unknown; upstream?: unknown }>("config.get"),
    /**
     * #2112 — the payload zone, FILTERED: keys always, values only where the
     * schema declares them public, secrets reduced to a short prefix. There is
     * deliberately no "reveal" call here: the values are reached with
     * `aiball payload dump`, a command someone runs, never a click.
     */
    getTicketPayload: (id: number) => call<PayloadView>("ticket.payload", { id }),
    revokeTicketPayload: (id: number) =>
        call<PayloadView>("ticket.revoke_payload", { id }),
    search: (params: {
        q: string;
        project?: string;
        open?: boolean;
        intent?: string;
        limit?: number;
    }) =>
        call<SearchHit[]>("message.search", {
            q: params.q,
            project: params.project || undefined,
            open: params.open || undefined,
            intent: params.intent || undefined,
            limit: params.limit,
        }),
    postponeTicket: (id: number, until: string) =>
        call<{ ticket_id: number; postponed_until: string }>("ticket.postpone", { id, until }),
    unsnoozeTicket: (id: number) =>
        call<{ ticket_id: number; postponed_until: null }>("ticket.unsnooze", { id }),
    /** Move a ticket (whole thread) to another project (#294). Reporter-or-
     *  human only. Returns the moved ticket header (with its new project). */
    moveTicket: (id: number, project: string) =>
        call<Message>("ticket.move", { id, project }),
    /** #2180 — a ticket's pending children, one level, each with who attached it
     *  and when. */
    pendingChildren: (id: number) =>
        call<{ ticket_id: number; children: PendingChild[] }>("ticket.pending_children", { id }),
    /** #2180 — approve exactly these children (human only). Ids that are not,
     *  or no longer, pending children come back in `skipped`, untouched. */
    approvePendingChildren: (id: number, ticketIds: number[]) =>
        call<{ ticket_id: number; approved: number[]; skipped: { ticket_id: number; reason: string }[] }>(
            "ticket.approve_pending_children",
            { id, ticket_ids: ticketIds },
        ),
    /** #514 — push (or self-claim if assignee = caller) the responsibility for
     *  a ticket. `assignee` empty/omitted = self-claim, else pushes to that
     *  consumer (human/moderator only for cross-assign). Returns the ticket head
     *  with new `assignee` + `assigned_by` + `assigned_at`. */
    assignTicket: (id: number, assignee: string) =>
        call<Message>("ticket.assign", { id, assignee }),
    /** #514 follow-up — release the current assignment/claim. Used by the
     *  ManagePanel to UNASSIGN a ticket (show-clear on the assignee Select). */
    releaseTicket: (id: number) =>
        call<Message>("ticket.release", { id }),
    /** #518 — vote +1 / -1 / 0 (retract) sur un commentaire, per-author.
     *  Le serveur stocke par consumer_id dans meta.votes. Renvoie le message
     *  décoré avec `votes_summary` recalculé pour le caller. */
    voteOnMessage: (id: number, value: 1 | -1 | 0) =>
        call<Message>("message.vote", { id, value }),
    // ---- ticket subscription / mute + owner (#352) -----------------------
    /** Current consumer's relationship to a ticket: "followed" | "muted" | null. */
    ticketSubState: (ticketId: number) =>
        call<{ consumer_id: string; ticket_id: number; state: "followed" | "muted" | null }>(
            "ticket.subscription",
            { ticket_id: ticketId, consumer_id: currentConsumer() },
        ),
    /** Follow (muted=false) or mute (muted=true) a ticket for the current consumer. */
    setTicketSub: (ticketId: number, muted: boolean) =>
        call<{ consumer_id: string; ticket_id: number; muted: boolean }>(
            "ticket.subscribe",
            { consumer_id: currentConsumer(), ticket_id: ticketId, muted },
        ),
    /** Reassign a ticket's owner (= by_agent). Moderator-only server-side (#352). */
    changeTicketOwner: (ticketId: number, owner: string) =>
        call<{ ticket_id: number; owner: string }>("ticket.set_owner", { id: ticketId, owner }),
    /** #352: a ticket's explicit subscriptions (follows + mutes). Moderator-only. */
    ticketSubscriptions: (ticketId: number) =>
        call<{ ticket_id: number; subscriptions: { consumer_id: string; muted: boolean; subscribed_at: string }[] }>("ticket.subscribers", { id: ticketId }),
    // ---- upstream coupling (GitHub / GitLab) -----------------------------
    /** Import an external issue (`gh#123` or `gh:owner/repo#123`) as a new
     *  coupled ticket. 409 if already coupled (with `existing_ticket_id`). */
    importUpstream: (ref: string, project: string) =>
        call<{
            ticket: { id: number; title: string | null };
            external: { num: number; title: string; state: string; url: string; labels: string[] };
            provider: string;
        }>("ticket.import", { ref, project }),
    /** Export a ticket UP as a new GitHub issue and couple it. Writes to the
     *  remote — call only from a confirmed action. `repo` overrides the
     *  project's default binding. */
    exportUpstream: (ticketId: number, repo?: string) =>
        call<{
            ticket: { id: number };
            external: { num: number; url: string };
            provider: string;
        }>("ticket.export", {
            id: ticketId,
            ...(repo ? { repo } : {}),
        }),
    /** #352: mute/unmute one SPECIFIC subscriber's subscription on a ticket. */
    muteSubscription: (ticketId: number, consumerId: string, muted: boolean) =>
        call<{ consumer_id: string; ticket_id: number; muted: boolean }>(
            "ticket.subscribe",
            { consumer_id: consumerId, ticket_id: ticketId, muted },
        ),
    /** Delete a comment (#309) — human moderator only. Soft-delete (the
     *  comment becomes a tombstone in the UI, invisible to agents/MCP). */
    deleteComment: (id: number) =>
        call<Message>("message.delete", { id }),
    /** Resurface a message (#827) — clear `seen_at` on every ping row
     *  pointing at it, so recipients re-see it at their next wake.
     *  Human-only. Returns `{ resurfaced: N }` (count flipped). */
    resurface: (id: number) =>
        call<{ resurfaced: number }>("message.resurface", { id }),
    postMessage: (body: PostMessageInput) =>
        call<Message>("message.post", { ...body }),
    /** Add (or supersede) a typed inter-ticket relation (#B.123 phase B).
     *  Append-only: posting with the same target replaces; posting with
     *  kind="ignored" tombstones the relation. */
    addRelation: (
        ticketId: number,
        target: number,
        kind: import("./relations").RelationKind,
    ) =>
        call<{ ticket_id: number; event_id: number; relations: TicketRelation[] }>(
            "ticket.relate",
            { id: ticketId, target_ticket_id: target, kind },
        ),
    approve: (id: number) =>
        call<Message>("message.approve", { id }),
    reject: (id: number) =>
        call<Message>("message.reject", { id }),
    /** #618 — atomic accept-and-close. Replaces the 2-step
     *  `approve(id)` + `postMessage({kind:"ticket_closed"})` flow with
     *  a single round-trip ; the server enchaîne synchroniquement les
     *  2 effects + leurs broadcasts WS arrivent dos-à-dos chez le
     *  client. The `body` optional rides along on the close event so
     *  the reporter's note is part of the same audit row. Returns the
     *  approved decision + the close event as separate Messages. */
    acceptAndClose: (id: number, body?: string) =>
        call<{ approved: Message; closed: Message }>(
            "message.accept_and_close",
            body ? { id, body } : { id },
        ),
    /** Accept or reject a comment's decision (#B.129). The comment must
     *  carry `meta.decision={kind, status:"pending"}` set by the
     *  author at post time. Idempotent; 409 if the decision is
     *  already terminal. `new_kind` optionally reclassifies the
     *  decision at decide-time (e.g. "accept this resolution as a
     *  plan instead" — #B.129 follow-up). */
    decide: (
        id: number,
        status: "accepted" | "rejected",
        new_kind?: DecisionKind,
        // #980 — closing note carried on the server-side auto-close event
        // for resolution/wontfix accepts (one call does decide + close).
        closeBody?: string,
    ) =>
        call<Message>("message.decide", {
            id,
            status,
            new_kind,
            ...(closeBody ? { body: closeBody } : {}),
        }),
    /** Reclassify a pending decision's kind without changing its
     *  status (#B.129 follow-up). 409 when the decision is missing
     *  or already terminal. */
    reclassify: (id: number, new_kind: DecisionKind) =>
        call<Message>("message.reclassify", { id, new_kind }),
    /** Promote an undecorated comment to a decision (#B.256).
     *  `status` omitted → tag as pending. `status` set → tag +
     *  decide in one gesture. Works whether the comment had a
     *  prior decision or not. */
    promoteMessage: (
        id: number,
        kind: "plan" | "resolution",
        status?: "accepted" | "rejected",
    ) =>
        call<Message>("message.promote", { id, kind, status }),
    /** Untag a comment — drops `meta.decision` (#B.256 dzm3ef).
     *  409 when the decision is already terminal. */
    untagMessage: (id: number) =>
        call<Message>("message.untag", { id }),
    /** #2369 — tag an agent's comment as a step after the fact, or remove that tag. */
    stepMessage: (id: number) =>
        call<Message>("message.step", { id }),
    /** #2383 — mark the ticket as a step (its latest agent comment), or remove that tag. */
    stepTicket: (id: number) =>
        call<Message>("ticket.step", { id }),
    unstepTicket: (id: number) =>
        call<Message>("ticket.unstep", { id }),
    unstepMessage: (id: number) =>
        call<Message>("message.unstep", { id }),
    /** #2910 — a project's milestones, oldest first. */
    listMilestones: (project: string) =>
        call<{ project: string; milestones: MilestoneRow[] }>("project.milestones", { project }),
    /** #2910 — put a ticket in a milestone, move it, or take it out (null). */
    setTicketMilestone: (id: number, milestoneId: number | null) =>
        call<{ ticket_id: number; milestone: MilestoneRef | null }>("ticket.set_milestone", { id, milestone_id: milestoneId }),
    edit: (id: number, body: { title?: string; body?: string; intent?: Intent | null; priority?: Priority | null; scope?: "internal" | "default" | "broadcast" | null; level?: "task" | "milestone" | "roadmap" }) =>
        call<Message>("message.edit", { ...body, id }),
    note: (id: number, note: string | null) =>
        call<Message>("message.note", { id, note }),

    /**
     * Mark a question (GFM `- [ ]` item with a `<!-- q:<id> -->` marker
     * in the parent body) as answered (#B.104). Flips the checkbox and
     * records the audit (`meta.questions[qid]`). Idempotent.
     */
    markQuestionAnswered: (
        messageId: number,
        questionId: string,
        body: { answered_in: number },
    ) =>
        call<Message>("message.answer_question", { ...body, id: messageId, qid: questionId }),

    // #447: per-agent work filters.

    // #457 slice 4: unified automation rules CRUD.
    listAutomationRules: (filters?: { trigger?: AutomationTrigger; enabledOnly?: boolean }) =>
        call<AutomationRule[]>("automation.rules", {
            trigger: filters?.trigger,
            enabled_only: filters?.enabledOnly || undefined,
        }),
    addAutomationRule: (body: {
        triggers: AutomationTrigger[] | AutomationTrigger;
        scope_consumer?: string | null;
        match_project?: string | null;
        match_kind?: string | null;
        match_by_agent?: string | null;
        match_tags?: string[];
        match_tag_added?: string | null;
        match_intent?: string | null;
        match_priority?: string | null;
        /** Slice 5.2 — canonical condition tree (overrides the synth from
         *  flat match_* fields when set). */
        expression?: ConditionTree;
        /** Slice 5.4 : canonical action stack. Server wins over `action`
         *  when both are present. */
        actions?: AutomationAction[];
        /** Legacy single action — server wraps as `[action]`. Either this
         *  or `actions` is required ; the latter is preferred for new code. */
        action?: AutomationAction;
        position?: number;
        note?: string | null;
    }) => call<AutomationRule>("automation.create_rule", { ...body }),
    delAutomationRule: (id: number) => call<{ id: number; deleted: boolean }>("automation.delete_rule", { id }),
    toggleAutomationRule: (id: number, enabled: boolean) =>
        call<AutomationRule>("automation.update_rule", { id, enabled }),
    /** Slice 5.3b — full partial-update : any subset of triggers / expression /
     *  actions / match_* / note / position / enabled. Backend validates per-field. */
    patchAutomationRule: (
        id: number,
        body: {
            triggers?: AutomationTrigger[] | AutomationTrigger;
            scope_consumer?: string | null;
            match_project?: string | null;
            match_kind?: string | null;
            match_by_agent?: string | null;
            match_tags?: string[];
            match_tag_added?: string | null;
            match_intent?: string | null;
            match_priority?: string | null;
            expression?: ConditionTree;
            actions?: AutomationAction[];
            action?: AutomationAction;
            enabled?: boolean;
            position?: number;
            note?: string | null;
        },
    ) => call<AutomationRule>("automation.update_rule", { ...body, id }),

    // #449: unified config manager. Pass a project for the per-project view
    // (overrides + effective); omit it for the global view.
    listManagedConfig: (project?: string | null) =>
        call<{ project: string | null; config: ManagedConfigRow[] }>("config.managed", { project: project || undefined }),
    setManagedConfig: (key: string, value: ConfigPrimitive, project?: string | null) =>
        call<{ key: string; project: string | null; value: ConfigPrimitive }>("config.set", project ? { key, value, project } : { key, value }),
    clearManagedConfig: (key: string, project?: string | null) =>
        call<{ key: string; project: string | null; cleared: boolean }>("config.clear", { key, project: project || undefined }),

    listTags: () => call<Tag[]>("tag.list"),
    // Merged config+DB catalog for the Tags admin panel (#223). Pass a
    // project name to scope, or "_global" for the cross-project view.
    listTagCatalog: (project: string) =>
        call<CatalogTag[]>("tag.list", { project }),
    // Config-tag override (#223 zcjqgp): color/order are editable even for
    // config tags; the override is keyed by name. `color: null` resets to
    // the config default.
    overrideTag: (body: { name: string; color?: string | null; position?: number }) =>
        call<Tag>("tag.override", { ...body }),
    addTag: (body: { name: string; color?: string; note?: string; position?: number; project?: string | null }) =>
        call<Tag>("tag.create", { ...body }),
    updateTag: (
        id: number,
        body: Partial<{ name: string; color: string | null; note: string | null; position: number }>,
    ) => call<Tag>("tag.update", { ...body, id }),
    delTag: (id: number) => call<{ id: number; deleted: boolean }>("tag.delete", { id }),
    setMessageTags: (id: number, tag_ids: number[]) =>
        call<Tag[]>("message.set_tags", { id, tag_ids }),

    getStrategy: () => call<{ strategy: Strategy }>("strategy.get"),
    setStrategy: (s: Strategy) =>
        call<{ strategy: Strategy }>("strategy.set", { strategy: s }),

    // ---- auth (#B.94) ----------------------------------------------------
    authStatus: () =>
        req<{
            ready: boolean;
            install_available: boolean;
            me: { consumer_id: string; kind: "auth" | "agent" } | null;
        }>("GET", "/api/auth/status"),
    authSetup: (body: {
        token: string;
        consumer_id: string;
        password: string;
        display_name?: string | null;
    }) => req<{ token: string; consumer_id: string }>("POST", "/api/auth/setup", body),
    authLogin: (body: { consumer_id: string; password: string }) =>
        req<{ token: string; consumer_id: string }>("POST", "/api/auth/login", body),
    authLogout: () => req<{ ok: boolean }>("POST", "/api/auth/logout"),
    me: () => call<Consumer>("consumer.me"),

    listConsumers: () => call<Consumer[]>("consumer.list"),
    /** #393: launch a claude-loop for a known local root of this project
     *  (human-only, server validates the root). */
    launchLoop: (project: string, root: string) =>
        call<{ ok: boolean; project: string; root: string; pid: number }>("project.launch", { name: project, root }),
    upsertConsumer: (body: {
        consumer_id: string;
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
    }) => call<Consumer>("consumer.upsert", { ...body }),
    updateConsumer: (
        consumer_id: string,
        patch: Partial<{ kind: ConsumerKind; display_name: string | null; enabled: boolean; note: string | null; micro_prompt: string | null; can_claim: boolean; can_create_agent: boolean; agent_type: "coder" | "cto"; notify_project_broadcasts: boolean | null }>,
    ) => call<Consumer>("consumer.update", { ...patch, consumer_id }),
    deleteConsumer: (consumer_id: string) =>
        call<{ consumer_id: string; deleted: boolean }>("consumer.delete", { consumer_id }),
    /** #442: remotely hard-kill the claude-loop running as this consumer.
     *  `delivered` = a live loop was connected to receive the control event. */
    /** #2645 — one agent's wait credit per project, and its latest movements. */
    consumerWaitCredit: (consumer_id: string) =>
        call<{ consumer_id: string; credits: WaitCreditRow[] | null; moves: WaitCreditMove[] }>("consumer.wait_credit", { consumer_id }),
    stopLoop: (consumer_id: string) =>
        call<{ consumer_id: string; action: string; delivered: boolean }>("consumer.stop_loop", { consumer_id }),
    /** #1185 — operator prune of a consumer's ping backlog across all
     *  projects. `del` hard-deletes the rows; default marks them seen.
     *  Gated server-side to the human moderator (this UI). */
    markReadProject: (opts: { consumer: string; allProjects: boolean; del?: boolean }) =>
        call<{ consumer_id: string; affected: number; deleted: boolean }>(
            "unread.mark_read",
            {
                consumer_id: opts.consumer,
                ...(opts.allProjects ? { all_projects: true } : {}),
                ...(opts.del ? { delete: true } : {}),
            },
        ),
    /** #451: send a raw, unfiltered prompt straight into this loop's Claude
     *  session. Always `spooled`; `delivered` = a live loop received it now
     *  (else it's drained from the spool when the loop reconnects). */
    sendLoopPrompt: (consumer_id: string, text: string) =>
        call<{ consumer_id: string; action: string; spooled: boolean; delivered: boolean }>("consumer.prompt", { consumer_id, text }),
    /** #2333 — type a message into every live agent loop; with `hold`, then
     *  hold each one indefinitely (NOT AFK ∞). One result per loop. */
    messageAllLoops: (message: string, hold: boolean) =>
        call<{ action: string; results: LoopHoldResult[] }>("loops.message_all", { message, hold }),
    /** #2333 — lift the hold on every live agent loop. */
    releaseAllLoops: () =>
        call<{ action: string; results: LoopHoldResult[] }>("loops.release_all"),
    /** #398: operator-approved command launchers (declared in the global
     *  config `launchers:` list; the API only ever takes an id). */
    listLaunchers: () => call<Launcher[]>("launcher.list"),
    /** #747 — hold or release an agent's loop (AFK), as its own keys would. */
    agentAfk: (name: string, action: "toggle" | "off" | "arm_10m" | "arm_inf") =>
        call<{ consumer_id: string; action: string; queued: boolean }>("consumer.afk", { name, action }),
    /** #3128: keys typed into an agent's session, as xterm produced them. */
    paneKeys: (agent: string, keys: string) => call<{ sent: number }>("agent.pane_keys", { agent, keys }),
    /** #3128: the size a typing viewer would like, for a session on the host. */
    paneResize: (agent: string, rows: number, cols: number) => call<{ applied: boolean }>("agent.pane_resize", { agent, rows, cols }),
    /** #398: run a launcher by id (human-only; detached spawn on the host). */
    runLauncher: (id: string) =>
        call<{ ok: boolean; id: string; label: string; pid: number }>("launcher.run", { id }),
    /** #424: proxy-node tokens + the consumers each relays (moderator-only). */
    listNodes: () => call<NodeView[]>("node.list"),
    /** #2074 — the enrolment switch: the public pairing route only answers
     *  while this window is open. Shut by default, and shut again on restart. */
    getPairingWindow: () => call<PairingWindow>("node.pairing"),
    setPairingWindow: (verb: "open" | "close", minutes?: number) =>
        call<PairingWindow>("node.set_pairing", verb === "open" ? { verb, minutes } : { verb }),
    /** #2074 — proxy nodes asking to be paired, waiting on a human. */
    listNodeEnrollments: () => call<NodeEnrollment[]>("node.enrollments"),
    /** #2074 — approve mints the node's token; reject is final. Both refuse a
     *  request that is no longer pending, so a stale panel cannot double-mint. */
    decideNodeEnrollment: (id: string, verdict: "approve" | "reject") =>
        call<NodeEnrollment>("node.decide_enrollment", { id, verdict }),
    /** #424: revoke a node by its non-secret handle (deletes the node token). */
    revokeNode: (node_id: string) =>
        call<{ node_id: string; revoked: boolean }>("node.revoke", { node_id }),
    /** #2276 — signal keys (moderator-only). With a project, each key also
     *  counts the signals that reached it. Never carries a token. */
    listSignalKeys: (project?: string) =>
        call<SignalKeyView[]>("signal_key.list", { project: project || undefined }),
    /** #2276 — the ONLY answer that carries the token: show it once. */
    createSignalKey: (label: string, note: string, grants?: { scopes: string[]; projects: string[] }) =>
        call<{ key: SignalKeyView; token: string }>("signal_key.create", { label, note, ...(grants ?? {}) }),
    /** #2526 — change what a key may do, and where it may create tickets. */
    updateSignalKeyGrants: (key_id: string, scopes: string[], projects: string[]) =>
        call<SignalKeyView>("signal_key.update", { key_id, scopes, projects }),
    updateSignalKeyNote: (key_id: string, note: string) =>
        call<SignalKeyView>("signal_key.update", { key_id, note }),
    revokeSignalKey: (key_id: string) =>
        call<{ key_id: string; revoked: boolean }>("signal_key.revoke", { key_id }),
    /** #2276 — signals aimed at the project or at one of its owners, newest first. */
    listProjectSignals: (project: string) =>
        call<{ project: string; signals: ProjectSignal[] }>("project.signals", { name: project }),
};

/** #2276 — a signal key as the Signals tab shows it: addressed by `key_id`, never by its token. */
export interface SignalKeyView {
    key_id: string;
    /** The source every signal posted with this key carries. */
    label: string;
    /** Who the key was given to and why. NULL on a key minted before notes existed. */
    note: string | null;
    created_at: string;
    last_used_at: string | null;
    signals_sent: number;
    signals_to_project?: number;
    /** #2526 — `signals`, `tickets:create`. */
    scopes: string[];
    /** #2526 — where it may create tickets. */
    projects: string[];
}

/** #2276 — a signal a project received, with each recipient's delivery state. */
export interface ProjectSignal {
    id: number;
    source: string;
    target_consumer: string | null;
    target_project: string | null;
    target_level: string | null;
    title: string;
    body: string | null;
    severity: "normal" | "panic";
    repeat_count: number;
    created_at: string;
    updated_at: string;
    expires_at: string;
    deliveries: { recipient: string; state: "delivered" | "pending" | "expired"; acked_at: string | null }[];
}

/** #424: a proxy node for the Nodes panel — never carries the token value. */
export interface NodeView {
    node_id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    last_seen_ip: string | null;
    /** #524: provider-resolved hostname (tailscale → hostname → …) shipped by
     *  the node in its WS `hello` frame. NULL when never advertised (legacy or
     *  non-WS node). The companion `display_host_provider` tells which
     *  provider gave it (used by the UI chip). */
    display_host: string | null;
    display_host_provider: string | null;
    relayed: { consumer_id: string; last_seen_at: string | null }[];
    relayed_count: number;
    /** #510 — état du WS reverse (canal /ws/proxy-node) si le daemon
     *  upstream l'a décoré. Absent quand le serveur tourne sur un build pre-#510
     *  (back-compat). */
    ws_state?: {
        connected: boolean;
        last_frame_at: string | null;
        silent_for_sec: number | null;
        /** #513 — version + commit reportés par le proxy dans son frame hello.
         *  NULL avant connexion ou pre-build qui n'envoie pas ces champs. */
        node_version?: string | null;
        node_commit?: string | null;
    };
    /** #2085 — set on a node that no longer exists: the credential is gone and
     *  this row is the receipt for the click that destroyed it. Shown greyed
     *  for an hour, then forgotten. Absent/null on a live node. */
    revoked_at?: string | null;
    revoked_by?: string | null;
}

/** #2333 — one loop's outcome in a message-all / release-all. */
export interface LoopHoldResult {
    consumer_id: string;
    /** Set on a message: typed into the live session now, or queued until the loop reconnects. */
    prompt?: "delivered" | "spooled";
    /** Set when a hold was asked (armed) or released, or could not be. */
    hold?: "armed" | "released" | "failed";
    hold_error?: string;
}
