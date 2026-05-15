export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

// Business enums are centralised in `./domain.ts` (#B.122). Re-export
// them here so existing consumers that import from `./api` still work.
export {
    MESSAGE_KINDS,
    MESSAGE_STATUSES,
    INTENTS,
    STRATEGIES,
    isMessageKind,
    isMessageStatus,
    isIntent,
    isStrategy,
} from "./domain";
export type { MessageKind, MessageStatus, Intent, Strategy } from "./domain";
import type { MessageKind, MessageStatus, Intent, Strategy } from "./domain";

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
    broadcast?: boolean;
    /** Snooze (#B.329) — when set and in the future, the ticket is
     *  hidden from the open inbox until that timestamp. */
    postponed_until?: string | null;
    intent: Intent | null;
    /** Parent ticket id when this ticket is a sub-ticket. Rendered as
     *  "Sub-ticket of #B.NN" metadata in the thread header. */
    parent_ticket_id?: number | null;
    /** Direct children of this ticket (sub-tickets). Empty when none.
     *  Rendered as a recap in the parent's thread header. */
    sub_tickets?: SubTicketSummary[];
    tags: Tag[];
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
    closed: boolean;
    resolved?: boolean;
    /** Agent signalled "I'm stuck, your call" (#B.119). */
    blocked?: boolean;
    /** Some agent has proposed this ticket as resolved, awaiting reporter's accept/reject. */
    pending_resolution?: boolean;
    broadcast?: boolean;
    /** Per-consumer flag: ≥1 unseen ping on the thread for the requesting consumer. */
    unread?: boolean;
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
    /** #B.129 — tag a comment as a decision proposal at post-time
     *  (server validates: `"plan" | "resolution"`, comment_added only). */
    decision_kind?: "plan" | "resolution";
}

/** Consumer registry entry (#B.79). */
export type ConsumerKind = "human" | "agent" | "sandbox";
export interface Consumer {
    consumer_id: string;
    kind: ConsumerKind;
    display_name: string | null;
    enabled: boolean;
    note: string | null;
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
}

export const api = {
    listProjects: () => req<string[]>("GET", "/api/projects"),
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
            include_postponed?: boolean;
        } = {},
    ) => {
        const qs = new URLSearchParams();
        if (params.project) qs.set("project", params.project);
        if (params.status) qs.set("status", params.status);
        if (params.open) qs.set("open", "1");
        if (params.intent) qs.set("intent", params.intent);
        if (params.include_postponed) qs.set("include_postponed", "1");
        const q = qs.toString();
        return req<InboxRow[]>("GET", `/api/inbox${q ? "?" + q : ""}`);
    },
    markTicketRead: (id: number) =>
        req<{ ticket_id: number; updated: number }>(
            "POST",
            `/api/tickets/${id}/mark-read`,
            {},
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
    getTicket: (id: number) => req<ThreadView>("GET", `/api/tickets/${id}?full=1`),
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
    setTicketBroadcast: (id: number, broadcast: boolean) =>
        req<TicketSummary>("PATCH", `/api/tickets/${id}`, { broadcast }),
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
    postMessage: (body: PostMessageInput) =>
        req<Message>("POST", "/api/messages", body),
    approve: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/approve`),
    reject: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/reject`),
    /** Accept or reject a comment's decision (#B.129). The comment must
     *  carry `meta.decision={kind, status:"pending"}` set by the
     *  author at post time. Idempotent; 409 if the decision is
     *  already terminal. */
    decide: (id: number, status: "accepted" | "rejected") =>
        req<Message>("POST", `/api/messages/${id}/decide`, { status }),
    edit: (id: number, body: { title?: string; body?: string; intent?: Intent | null }) =>
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

    listTags: () => req<Tag[]>("GET", "/api/tags"),
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
    upsertConsumer: (body: {
        consumer_id: string;
        kind?: ConsumerKind;
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
    }) => req<Consumer>("POST", "/api/consumers", body),
    updateConsumer: (
        consumer_id: string,
        patch: Partial<{ kind: ConsumerKind; display_name: string | null; enabled: boolean; note: string | null }>,
    ) => req<Consumer>("PATCH", `/api/consumers/${encodeURIComponent(consumer_id)}`, patch),
    deleteConsumer: (consumer_id: string) =>
        req<{ consumer_id: string; deleted: boolean }>(
            "DELETE",
            `/api/consumers/${encodeURIComponent(consumer_id)}`,
        ),
};
