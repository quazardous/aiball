export interface Message {
    id: number;
    project: string;
    kind: "ticket_created" | "comment_added" | "ticket_closed";
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
    closed: boolean;
}

export interface ThreadView {
    ticket: TicketSummary;
    comments: Message[];
}

export interface PostMessageInput {
    project: string;
    kind: "ticket_created" | "comment_added" | "ticket_closed";
    title?: string;
    body?: string;
    by_agent?: string;
    ticket_id?: number;
    parent_id?: number;
}

export const api = {
    listProjects: () => req<string[]>("GET", "/api/projects"),
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
};
