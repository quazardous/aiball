export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

export type Intent = "panic" | "request" | "question" | "fyi";
export const INTENTS: readonly Intent[] = ["panic", "request", "question", "fyi"];

export type Strategy = "manual" | "auto" | "auto-reply";
export const STRATEGIES: readonly Strategy[] = ["manual", "auto", "auto-reply"];

export interface Message {
    id: number;
    project: string;
    kind:
        | "ticket_created"
        | "comment_added"
        | "ticket_closed"
        | "ticket_reopened"
        | "ticket_resolved"
        | "ticket_sub_added"
        | "ticket_referenced";
    ticket_id: number | null;
    parent_id: number | null;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    status: "pending" | "approved" | "rejected";
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
    tags: Tag[];
}

export type TicketStage =
    | "rejected"
    | "closed-resolved"
    | "closed"
    | "resolved"
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
        "x-aiball-consumer": currentConsumer(),
    };
    if (body) headers["content-type"] = "application/json";
    const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
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
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: "pending" | "approved" | "rejected";
    closed: boolean;
    resolved?: boolean;
    resolved_by?: string | null;
    resolved_at?: string | null;
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
    status: "pending" | "approved" | "rejected";
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
    status: "pending" | "approved" | "rejected";
    /** HTML snippet with `<mark>…</mark>` around matched terms. */
    snippet: string;
    rank: number;
}

export interface InboxRow {
    id: number;
    project: string;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: "pending" | "approved" | "rejected";
    intent: Intent | null;
    closed: boolean;
    resolved?: boolean;
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
    kind: "ticket_created" | "comment_added" | "ticket_closed" | "ticket_reopened" | "ticket_resolved";
    title?: string;
    body?: string;
    by_agent?: string;
    ticket_id?: number;
    parent_id?: number;
    intent?: Intent | null;
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
    getTicket: (id: number) => req<ThreadView>("GET", `/api/tickets/${id}`),
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
    edit: (id: number, body: { title?: string; body?: string; intent?: Intent | null }) =>
        req<Message>("POST", `/api/messages/${id}/edit`, body),
    note: (id: number, note: string | null) =>
        req<Message>("POST", `/api/messages/${id}/note`, { note }),

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
};
