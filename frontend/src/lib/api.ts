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
    edited_title: string | null;
    edited_body: string | null;
    intent: Intent | null;
    /** Per-ticket urgency hint (#B.222). Tickets only; defaults to
     *  "normal" at the SQL layer if absent. Comments and lifecycle
     *  events omit this field on the wire. */
    priority?: Priority;
    /** Public ref for comments / lifecycle events. NULL for tickets. */
    hashid?: string | null;
    /** Set on `ticket_sub_added` / `ticket_referenced` pseudo-comments —
     *  the source ticket that triggered the relation event. */
    source_ticket_id?: number | null;
    /** Lifecycle stage of the source ticket, populated server-side for
     *  ticket_referenced / ticket_sub_added rows so the UI can render a
     *  small "where is this relation pointing now?" badge. */
    source_ticket_stage?: TicketStage;
    /** Sidecar JSON (raw string from the DB). Carries question audit
     *  (#B.104) and decision-on-comment (#B.129). Parsed lazily by
     *  components that need it. */
    meta?: string | null;
    /** #B.245 event scope tristate. `internal` = owners+@mentions
     *  only; `default` = subscribers+owners+@mentions; `broadcast` =
     *  + followers. Drives the per-card scope picto. */
    scope?: "internal" | "default" | "broadcast";
    tags: Tag[];
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

export interface Rule {
    id: number;
    position: number;
    match_project: string | null;
    match_kind: string | null;
    match_by_agent: string | null;
    decision: "auto" | "review";
    enabled: 0 | 1;
    note: string | null;
    created_at: string;
}

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
export interface WorkFilter {
    id: number;
    consumer_id: string;
    project: string | null;
    mode: "only" | "except";
    match_tags: string[];
    enabled: 0 | 1;
    position: number;
    note: string | null;
    created_at: string;
}

/** #449: one schema key resolved for the config-manager UI — meta + each layer
 *  (global/project override) + the effective value. Mirrors the backend's
 *  ResolvedConfig. `value`/layers are string|number|boolean per the key's type. */
export type ConfigPrimitive = string | number | boolean;
export interface ManagedConfigRow {
    key: string;
    scope: "global" | "global+project" | "project";
    type: "string" | "number" | "boolean" | "enum";
    options: string[] | null;
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
        "x-aiball-consumer": currentConsumer(),
    };
    if (body) headers["content-type"] = "application/json";
    const tok = currentToken();
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    const res = await fetch(path, {
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
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

export interface TicketSummary {
    id: number;
    project: string;
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
}

/** #404: per-ticket token-effort tally (raw counts from the Claude transcript). */
export interface TokenUsage {
    tokens_in: number;
    tokens_out: number;
    cache_w: number;
    cache_r: number;
    updated_at: string;
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
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: MessageStatus;
    intent: Intent | null;
    /** Urgency hint (#B.222). Defaults to "normal" server-side. */
    priority?: Priority;
    closed: boolean;
    resolved?: boolean;
    /** Agent signalled "I'm stuck, your call" (#B.119). */
    blocked?: boolean;
    /** Some agent has proposed this ticket as resolved, awaiting reporter's accept/reject. */
    pending_resolution?: boolean;
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
    by_agent?: string;
    ticket_id?: number;
    parent_id?: number;
    intent?: Intent | null;
    /** #B.222 urgency hint (ticket_created only; defaults to "normal"). */
    priority?: Priority;
    /** #B.129 — tag a comment as a decision proposal at post-time
     *  (server validates: `"plan" | "resolution"`, comment_added only). */
    decision_kind?: "plan" | "resolution";
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
    /** #B.177: ISO8601 of last API call from this consumer. */
    last_seen_at?: string | null;
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
    state_human_word?: "stop" | "wait" | "ask" | "loop" | null;
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

export const api = {
    listProjects: () => req<string[]>("GET", "/api/projects"),
    /**
     * Explicitly register a project (#B.216 phase A pass 2). 409 means
     * the name already exists; 400 means empty/whitespace name.
     */
    createProject: (
        name: string,
        opts: { display_name?: string; description?: string; created_by?: string } = {},
    ) =>
        req<{
            name: string;
            display_name: string | null;
            description: string | null;
            created_at: string;
            created_by: string | null;
        }>("POST", "/api/projects", { name, ...opts }),
    listProjectsDetailed: (consumer_id?: string) => {
        const qs = consumer_id
            ? `?detailed=1&consumer_id=${encodeURIComponent(consumer_id)}`
            : "?detailed=1";
        return req<ProjectMeta[]>("GET", `/api/projects${qs}`);
    },
    deleteProject: (name: string) =>
        req<{ project: string; deleted_messages: number; ok: boolean }>(
            "DELETE",
            `/api/projects/${encodeURIComponent(name)}`,
        ),
    purgeOldClosed: (name: string, older_than_days = 365) =>
        req<{
            project: string;
            older_than_days: number;
            purged_tickets: number;
            purged_messages: number;
            ok: boolean;
        }>(
            "POST",
            `/api/projects/${encodeURIComponent(name)}/purge`,
            { older_than_days },
        ),
    // #475 david : global "Purge tickets closed > 1 year" depuis la Danger
    // zone de Settings > General. Boucle server-side sur listProjects().
    purgeAllOldClosed: (older_than_days = 365) =>
        req<{
            older_than_days: number;
            purged_tickets: number;
            purged_messages: number;
            per_project: { project: string; purged_tickets: number; purged_messages: number }[];
            ok: boolean;
        }>(
            "POST",
            `/api/tickets/purge`,
            { older_than_days },
        ),
    // #476 david : "ajout d'un zone information global — avec la taille des
    // data / image etc les infos etc". Daemon-wide info zone (version, db
    // size, uploads size, totals) rendered in Settings > General.
    getInfo: () =>
        req<{
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
        }>("GET", "/api/info"),
    projectStatsRich: (name: string) =>
        req<unknown>(
            "GET",
            `/api/projects/${encodeURIComponent(name)}/stats-rich`,
        ),
    // Per-project strategy override (#B.127). `strategy: null` in the
    // response = no override, the project follows the global strategy.
    getProjectStrategy: (name: string) =>
        req<{ project: string; strategy: Strategy | null; global: Strategy }>(
            "GET",
            `/api/projects/${encodeURIComponent(name)}/strategy`,
        ),
    setProjectStrategy: (name: string, strategy: Strategy | null) =>
        req<{ project: string; strategy: Strategy | null; global: Strategy }>(
            "PATCH",
            `/api/projects/${encodeURIComponent(name)}/strategy`,
            { strategy },
        ),
    mentionSuggestions: () =>
        req<{ projects: string[]; agents: string[] }>(
            "GET",
            "/api/mention-suggestions",
        ),
    listMessages: (params: {
        status?: string;
        project?: string;
        kind?: string;
        limit?: number;
    } = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
        }
        const q = qs.toString();
        return req<Message[]>("GET", `/api/messages${q ? "?" + q : ""}`);
    },
    listTickets: (params: { project?: string; open?: boolean } = {}) => {
        const qs = new URLSearchParams();
        if (params.project) qs.set("project", params.project);
        if (params.open) qs.set("open", "1");
        const q = qs.toString();
        return req<TicketSummary[]>("GET", `/api/tickets${q ? "?" + q : ""}`);
    },
    inbox: (
        params: {
            project?: string;
            status?: string;
            open?: boolean;
            intent?: string;
            priority?: Priority;
            include_postponed?: boolean;
        } = {},
    ) => {
        const qs = new URLSearchParams();
        if (params.project) qs.set("project", params.project);
        if (params.status) qs.set("status", params.status);
        if (params.open) qs.set("open", "1");
        if (params.intent) qs.set("intent", params.intent);
        if (params.priority) qs.set("priority", params.priority);
        if (params.include_postponed) qs.set("include_postponed", "1");
        const q = qs.toString();
        return req<InboxRow[]>("GET", `/api/inbox${q ? "?" + q : ""}`);
    },
    markTicketRead: (id: number, upToId?: number) =>
        req<{ ticket_id: number; updated: number; up_to_id?: number }>(
            "POST",
            `/api/tickets/${id}/mark-read`,
            typeof upToId === "number" ? { up_to_id: upToId } : {},
        ),
    markTicketUnread: (id: number) =>
        req<{ ticket_id: number; updated: number }>(
            "POST",
            `/api/tickets/${id}/mark-unread`,
            {},
        ),
    // The UI always needs the full thread (body + comments) — the
    // summary default that landed in 0.5.x (#B.87) targets agents, not
    // the moderator browser. Force full=1.
    // #309: include_deleted=1 surfaces user-deleted comments as tombstones in
    // the moderator UI (agents/MCP never pass it, so they don't see them).
    getTicket: (id: number) => req<ThreadView>("GET", `/api/tickets/${id}?full=1&include_deleted=1`),
    search: (params: {
        q: string;
        project?: string;
        open?: boolean;
        intent?: string;
        limit?: number;
    }) => {
        const qs = new URLSearchParams({ q: params.q });
        if (params.project) qs.set("project", params.project);
        if (params.open) qs.set("open", "1");
        if (params.intent) qs.set("intent", params.intent);
        if (params.limit !== undefined) qs.set("limit", String(params.limit));
        return req<SearchHit[]>("GET", `/api/search?${qs.toString()}`);
    },
    postponeTicket: (id: number, until: string) =>
        req<{ ticket_id: number; postponed_until: string }>(
            "POST",
            `/api/tickets/${id}/postpone`,
            { until },
        ),
    unsnoozeTicket: (id: number) =>
        req<{ ticket_id: number; postponed_until: null }>(
            "POST",
            `/api/tickets/${id}/unsnooze`,
            {},
        ),
    /** Move a ticket (whole thread) to another project (#294). Reporter-or-
     *  human only. Returns the moved ticket header (with its new project). */
    moveTicket: (id: number, project: string) =>
        req<Message>("POST", `/api/tickets/${id}/move`, { project }),
    /** #514 — push (or self-claim if assignee = caller) the responsibility for
     *  a ticket. `assignee` empty/omitted = self-claim, else pushes to that
     *  consumer (human/moderator only for cross-assign). Returns the ticket head
     *  with new `assignee` + `assigned_by` + `assigned_at`. */
    assignTicket: (id: number, assignee: string) =>
        req<Message>("POST", `/api/tickets/${id}/assign`, { assignee }),
    // ---- ticket subscription / mute + owner (#352) -----------------------
    /** Current consumer's relationship to a ticket: "followed" | "muted" | null. */
    ticketSubState: (ticketId: number) =>
        req<{ consumer_id: string; ticket_id: number; state: "followed" | "muted" | null }>(
            "GET",
            `/api/ticket-subscriptions/${ticketId}?consumer_id=${encodeURIComponent(currentConsumer())}`,
        ),
    /** Follow (muted=false) or mute (muted=true) a ticket for the current consumer. */
    setTicketSub: (ticketId: number, muted: boolean) =>
        req<{ consumer_id: string; ticket_id: number; muted: boolean }>(
            "POST",
            "/api/ticket-subscriptions",
            { consumer_id: currentConsumer(), ticket_id: ticketId, muted },
        ),
    /** Reassign a ticket's owner (= by_agent). Moderator-only server-side (#352). */
    changeTicketOwner: (ticketId: number, by_agent: string) =>
        req<{ ticket_id: number; by_agent: string }>(
            "POST",
            `/api/tickets/${ticketId}/owner`,
            { by_agent },
        ),
    /** #352: a ticket's explicit subscriptions (follows + mutes). Moderator-only. */
    ticketSubscriptions: (ticketId: number) =>
        req<{ ticket_id: number; subscriptions: { consumer_id: string; muted: boolean; subscribed_at: string }[] }>(
            "GET",
            `/api/tickets/${ticketId}/subscriptions`,
        ),
    /** #352: mute/unmute one SPECIFIC subscriber's subscription on a ticket. */
    muteSubscription: (ticketId: number, consumerId: string, muted: boolean) =>
        req<{ consumer_id: string; ticket_id: number; muted: boolean }>(
            "POST",
            "/api/ticket-subscriptions",
            { consumer_id: consumerId, ticket_id: ticketId, muted },
        ),
    /** Delete a comment (#309) — human moderator only. Soft-delete (the
     *  comment becomes a tombstone in the UI, invisible to agents/MCP). */
    deleteComment: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/delete`, {}),
    postMessage: (body: PostMessageInput) =>
        req<Message>("POST", "/api/messages", body),
    /** Add (or supersede) a typed inter-ticket relation (#B.123 phase B).
     *  Append-only: posting with the same target replaces; posting with
     *  kind="ignored" tombstones the relation. */
    addRelation: (
        ticketId: number,
        target: number,
        kind: import("./relations").RelationKind,
    ) =>
        req<{ ticket_id: number; event_id: number; relations: TicketRelation[] }>(
            "POST",
            `/api/tickets/${ticketId}/relations`,
            { target_ticket_id: target, kind },
        ),
    approve: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/approve`),
    reject: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/reject`),
    /** Accept or reject a comment's decision (#B.129). The comment must
     *  carry `meta.decision={kind, status:"pending"}` set by the
     *  author at post time. Idempotent; 409 if the decision is
     *  already terminal. `new_kind` optionally reclassifies the
     *  decision at decide-time (e.g. "accept this resolution as a
     *  plan instead" — #B.129 follow-up). */
    decide: (
        id: number,
        status: "accepted" | "rejected",
        new_kind?: "plan" | "resolution",
    ) =>
        req<Message>("POST", `/api/messages/${id}/decide`, { status, new_kind }),
    /** Reclassify a pending decision's kind without changing its
     *  status (#B.129 follow-up). 409 when the decision is missing
     *  or already terminal. */
    reclassify: (id: number, new_kind: "plan" | "resolution") =>
        req<Message>("POST", `/api/messages/${id}/reclassify`, { new_kind }),
    /** Promote an undecorated comment to a decision (#B.256).
     *  `status` omitted → tag as pending. `status` set → tag +
     *  decide in one gesture. Works whether the comment had a
     *  prior decision or not. */
    promoteMessage: (
        id: number,
        kind: "plan" | "resolution",
        status?: "accepted" | "rejected",
    ) =>
        req<Message>("POST", `/api/messages/${id}/promote`, { kind, status }),
    /** Untag a comment — drops `meta.decision` (#B.256 dzm3ef).
     *  409 when the decision is already terminal. */
    untagMessage: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/untag`, {}),
    edit: (id: number, body: { title?: string; body?: string; intent?: Intent | null; priority?: Priority | null }) =>
        req<Message>("POST", `/api/messages/${id}/edit`, body),
    note: (id: number, note: string | null) =>
        req<Message>("POST", `/api/messages/${id}/note`, { note }),

    /**
     * Mark a question (GFM `- [ ]` item with a `<!-- q:<id> -->` marker
     * in the parent body) as answered (#B.104). Flips the checkbox and
     * records the audit (`meta.questions[qid]`). Idempotent.
     */
    markQuestionAnswered: (
        messageId: number,
        questionId: string,
        body: { answered_by: string; answered_in: number },
    ) =>
        req<Message>(
            "POST",
            `/api/messages/${messageId}/questions/${encodeURIComponent(questionId)}/answer`,
            body,
        ),

    listRules: () => req<Rule[]>("GET", "/api/rules"),
    addRule: (body: {
        decision: "auto" | "review";
        match_project?: string | null;
        match_kind?: string | null;
        match_by_agent?: string | null;
        note?: string | null;
    }) => req<Rule>("POST", "/api/rules", body),
    delRule: (id: number) => req<void>("DELETE", `/api/rules/${id}`),
    toggleRule: (id: number, enabled: boolean) =>
        req<Rule>("PATCH", `/api/rules/${id}`, { enabled }),

    // #447: per-agent work filters.
    listWorkFilters: (consumerId?: string) =>
        req<WorkFilter[]>(
            "GET",
            `/api/work-filters${consumerId ? `?consumer_id=${encodeURIComponent(consumerId)}` : ""}`,
        ),
    addWorkFilter: (body: {
        consumer_id: string;
        project?: string | null;
        mode?: "only" | "except";
        match_tags: string[];
        note?: string | null;
    }) => req<WorkFilter>("POST", "/api/work-filters", body),
    delWorkFilter: (id: number) => req<void>("DELETE", `/api/work-filters/${id}`),
    toggleWorkFilter: (id: number, enabled: boolean) =>
        req<WorkFilter>("PATCH", `/api/work-filters/${id}`, { enabled }),

    // #457 slice 4: unified automation rules CRUD.
    listAutomationRules: (filters?: { trigger?: AutomationTrigger; enabledOnly?: boolean }) => {
        const q: string[] = [];
        if (filters?.trigger) q.push(`trigger=${encodeURIComponent(filters.trigger)}`);
        if (filters?.enabledOnly) q.push("enabled_only=1");
        return req<AutomationRule[]>(
            "GET",
            `/api/automation/rules${q.length ? `?${q.join("&")}` : ""}`,
        );
    },
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
    }) => req<AutomationRule>("POST", "/api/automation/rules", body),
    delAutomationRule: (id: number) => req<void>("DELETE", `/api/automation/rules/${id}`),
    toggleAutomationRule: (id: number, enabled: boolean) =>
        req<AutomationRule>("PATCH", `/api/automation/rules/${id}`, { enabled }),
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
    ) => req<AutomationRule>("PATCH", `/api/automation/rules/${id}`, body),

    // #449: unified config manager. Pass a project for the per-project view
    // (overrides + effective); omit it for the global view.
    listManagedConfig: (project?: string | null) =>
        req<{ project: string | null; config: ManagedConfigRow[] }>(
            "GET",
            `/api/managed-config${project ? `?project=${encodeURIComponent(project)}` : ""}`,
        ),
    setManagedConfig: (key: string, value: ConfigPrimitive, project?: string | null) =>
        req<{ key: string; project: string | null; value: ConfigPrimitive }>(
            "PUT",
            `/api/managed-config/${encodeURIComponent(key)}`,
            project ? { value, project } : { value },
        ),
    clearManagedConfig: (key: string, project?: string | null) =>
        req<void>(
            "DELETE",
            `/api/managed-config/${encodeURIComponent(key)}${project ? `?project=${encodeURIComponent(project)}` : ""}`,
        ),

    listTags: () => req<Tag[]>("GET", "/api/tags"),
    // Merged config+DB catalog for the Tags admin panel (#223). Pass a
    // project name to scope, or "_global" for the cross-project view.
    listTagCatalog: (project: string) =>
        req<CatalogTag[]>("GET", `/api/tags?project=${encodeURIComponent(project)}`),
    // Config-tag override (#223 zcjqgp): color/order are editable even for
    // config tags; the override is keyed by name. `color: null` resets to
    // the config default.
    overrideTag: (body: { name: string; color?: string | null; position?: number }) =>
        req<Tag>("PUT", "/api/tags/override", body),
    addTag: (body: { name: string; color?: string; note?: string; position?: number }) =>
        req<Tag>("POST", "/api/tags", body),
    updateTag: (
        id: number,
        body: Partial<{ name: string; color: string | null; note: string | null; position: number }>,
    ) => req<Tag>("PATCH", `/api/tags/${id}`, body),
    delTag: (id: number) => req<void>("DELETE", `/api/tags/${id}`),
    setMessageTags: (id: number, tag_ids: number[], set_by?: string) =>
        req<Tag[]>("PUT", `/api/messages/${id}/tags`, { tag_ids, set_by }),

    getStrategy: () => req<{ strategy: Strategy }>("GET", "/api/strategy"),
    setStrategy: (s: Strategy) =>
        req<{ strategy: Strategy }>("PATCH", "/api/strategy", { strategy: s }),

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
    me: () => req<Consumer>("GET", "/api/me"),

    listConsumers: () => req<Consumer[]>("GET", "/api/consumers"),
    /** #393: launch a claude-loop for a known local root of this project
     *  (human-only, server validates the root). */
    launchLoop: (project: string, root: string) =>
        req<{ ok: boolean; project: string; root: string; pid: number }>(
            "POST",
            `/api/projects/${encodeURIComponent(project)}/launch`,
            { root },
        ),
    upsertConsumer: (body: {
        consumer_id: string;
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
    }) => req<Consumer>("POST", "/api/consumers", body),
    updateConsumer: (
        consumer_id: string,
        patch: Partial<{ kind: ConsumerKind; display_name: string | null; enabled: boolean; note: string | null; micro_prompt: string | null; can_claim: boolean }>,
    ) => req<Consumer>("PATCH", `/api/consumers/${encodeURIComponent(consumer_id)}`, patch),
    deleteConsumer: (consumer_id: string) =>
        req<{ consumer_id: string; deleted: boolean }>(
            "DELETE",
            `/api/consumers/${encodeURIComponent(consumer_id)}`,
        ),
    /** #442: remotely hard-kill the claude-loop running as this consumer.
     *  `delivered` = a live loop was connected to receive the control event. */
    stopLoop: (consumer_id: string) =>
        req<{ consumer_id: string; action: string; delivered: boolean }>(
            "POST",
            `/api/consumers/${encodeURIComponent(consumer_id)}/loop-stop`,
        ),
    /** #451: send a raw, unfiltered prompt straight into this loop's Claude
     *  session. Always `spooled`; `delivered` = a live loop received it now
     *  (else it's drained from the spool when the loop reconnects). */
    sendLoopPrompt: (consumer_id: string, text: string) =>
        req<{ consumer_id: string; action: string; spooled: boolean; delivered: boolean }>(
            "POST",
            `/api/consumers/${encodeURIComponent(consumer_id)}/prompt`,
            { text },
        ),
    /** #398: operator-approved command launchers (declared in the global
     *  config `launchers:` list; the API only ever takes an id). */
    listLaunchers: () => req<Launcher[]>("GET", "/api/launchers"),
    /** #398: run a launcher by id (human-only; detached spawn on the host). */
    runLauncher: (id: string) =>
        req<{ ok: boolean; id: string; label: string; pid: number }>(
            "POST",
            `/api/launchers/${encodeURIComponent(id)}/run`,
        ),
    /** #424: proxy-node tokens + the consumers each relays (moderator-only). */
    listNodes: () => req<NodeView[]>("GET", "/api/nodes"),
    /** #424: revoke a node by its non-secret handle (deletes the node token). */
    revokeNode: (node_id: string) =>
        req<{ node_id: string; revoked: boolean }>("DELETE", `/api/nodes/${encodeURIComponent(node_id)}`),
};

/** #424: a proxy node for the Nodes panel — never carries the token value. */
export interface NodeView {
    node_id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    last_seen_ip: string | null;
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
}
