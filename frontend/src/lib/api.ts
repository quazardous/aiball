export interface Tag {
    id: number;
    name: string;
    color: string | null;
    position: number;
    note: string | null;
    created_at: string;
}

export type Priority = "panic" | "request" | "question" | "fyi";
export const PRIORITIES: readonly Priority[] = ["panic", "request", "question", "fyi"];

export type Strategy = "manual" | "auto" | "auto-reply";
export const STRATEGIES: readonly Strategy[] = ["manual", "auto", "auto-reply"];

export interface Message {
    id: number;
    project: string;
    kind: "ticket_created" | "comment_added" | "ticket_closed" | "ticket_reopened";
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
    priority: Priority | null;
    tags: Tag[];
}

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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
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
    priority: Priority | null;
    tags: Tag[];
}

export interface InboxRow {
    id: number;
    project: string;
    title: string | null;
    body: string | null;
    by_agent: string | null;
    created_at: string;
    status: "pending" | "approved" | "rejected";
    priority: Priority | null;
    closed: boolean;
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
    kind: "ticket_created" | "comment_added" | "ticket_closed" | "ticket_reopened";
    title?: string;
    body?: string;
    by_agent?: string;
    ticket_id?: number;
    parent_id?: number;
    priority?: Priority | null;
}

export interface ProjectMeta {
    name: string;
    last_activity: string;
    ticket_count: number;
    comment_count: number;
    pending_count: number;
    /** Set when listProjectsDetailed is called with a consumer_id. */
    unread_for_consumer?: number;
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
            priority?: string;
        } = {},
    ) => {
        const qs = new URLSearchParams();
        if (params.project) qs.set("project", params.project);
        if (params.status) qs.set("status", params.status);
        if (params.open) qs.set("open", "1");
        if (params.priority) qs.set("priority", params.priority);
        const q = qs.toString();
        return req<InboxRow[]>("GET", `/api/inbox${q ? "?" + q : ""}`);
    },
    getTicket: (id: number) => req<ThreadView>("GET", `/api/tickets/${id}`),
    postMessage: (body: PostMessageInput) =>
        req<Message>("POST", "/api/messages", body),
    approve: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/approve`),
    reject: (id: number) =>
        req<Message>("POST", `/api/messages/${id}/reject`),
    edit: (id: number, body: { title?: string; body?: string }) =>
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
