/**
 * Thin HTTP client to talk to the aiball daemon, with the same spool-fallback
 * semantics as the bash CLI: if POST /messages can't reach the daemon, drop a
 * JSON file in the spool directory so the daemon picks it up later.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export interface ClientOptions {
    url?: string;
    home?: string;
    timeoutMs?: number;
    agentId?: string;
    defaultProject?: string;
}

export interface SpoolResult {
    queued: true;
    file: string;
}

export class AiballClient {
    readonly url: string;
    readonly home: string;
    readonly spoolDir: string;
    readonly outboxDir: string;
    readonly timeoutMs: number;
    readonly agentId: string;
    readonly defaultProject: string | null;

    constructor(opts: ClientOptions = {}) {
        this.url = opts.url ?? process.env.AIBALL_URL ?? "http://127.0.0.1:7777";
        this.home =
            opts.home ??
            process.env.AIBALL_HOME ??
            join(homedir(), ".local", "share", "aiball");
        this.spoolDir = join(this.home, "spool");
        this.outboxDir = join(this.home, "outbox");
        this.timeoutMs = opts.timeoutMs ?? 2000;
        this.agentId = opts.agentId ?? resolveAgentId();
        this.defaultProject =
            opts.defaultProject ?? process.env.AIBALL_PROJECT ?? null;
    }

    /**
     * Resolve a project name: explicit arg wins, otherwise fall back to the
     * default project (env AIBALL_PROJECT). Throws if neither is set.
     */
    resolveProject(project?: string | null): string {
        const p = project ?? this.defaultProject;
        if (!p) {
            throw new Error(
                "project required: pass it explicitly or set AIBALL_PROJECT (e.g. in .mcp.json env)",
            );
        }
        return p;
    }

    private async http<T = unknown>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.url + path, {
                method,
                headers: body ? { "content-type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            if (!res.ok) {
                const txt = await res.text().catch(() => "");
                throw new Error(`${method} ${path} → ${res.status}: ${txt}`);
            }
            const ct = res.headers.get("content-type") ?? "";
            if (ct.includes("application/json")) return (await res.json()) as T;
            return undefined as unknown as T;
        } finally {
            clearTimeout(t);
        }
    }

    /** Try to POST a new message; on failure, queue it in the spool. */
    async postMessage(
        msg: Record<string, unknown>,
    ): Promise<unknown | SpoolResult> {
        try {
            return await this.http("POST", "/api/messages", msg);
        } catch {
            return this.spoolDrop(msg);
        }
    }

    private spoolDrop(msg: Record<string, unknown>): SpoolResult {
        mkdirSync(this.spoolDir, { recursive: true });
        const ts = process.hrtime.bigint().toString();
        const rnd = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
        const tmp = join(this.spoolDir, `.${ts}-${rnd}.tmp`);
        const final = join(this.spoolDir, `${ts}-${rnd}.json`);
        writeFileSync(tmp, JSON.stringify(msg), "utf8");
        renameSync(tmp, final);
        return { queued: true, file: final };
    }

    // ---- read endpoints (no spool fallback) -------------------------------

    listMessages(q: Record<string, string | number | undefined> = {}) {
        return this.http("GET", `/api/messages${query(q)}`);
    }
    getMessage(id: number) {
        return this.http("GET", `/api/messages/${id}`);
    }
    listTickets(q: Record<string, string | undefined> = {}) {
        return this.http("GET", `/api/tickets${query(q)}`);
    }
    getTicket(id: number) {
        return this.http("GET", `/api/tickets/${id}`);
    }
    listProjects() {
        return this.http("GET", "/api/projects");
    }
    feedPath(project: string) {
        return this.http<{ path: string }>(
            "GET",
            `/api/feed-path?project=${encodeURIComponent(project)}`,
        ).catch(() => {
            // Daemon down: compute locally
            if (!/^[a-zA-Z0-9_.-]+$/.test(project))
                throw new Error(`invalid project name: ${project}`);
            return { path: join(this.outboxDir, `${project}.jsonl`) };
        });
    }

    // ---- subscriptions ----------------------------------------------------

    subscribe(project: string, catchup = false) {
        return this.http("POST", "/api/subscriptions", {
            consumer_id: this.agentId,
            project,
            catchup,
        });
    }
    unsubscribe(project: string) {
        return this.http(
            "DELETE",
            `/api/subscriptions?consumer_id=${encodeURIComponent(this.agentId)}&project=${encodeURIComponent(project)}`,
        );
    }
    mySubs() {
        return this.http(
            "GET",
            `/api/subscriptions?consumer_id=${encodeURIComponent(this.agentId)}`,
        );
    }
    unread(project: string, limit = 100) {
        return this.http(
            "GET",
            `/api/unread?consumer_id=${encodeURIComponent(this.agentId)}&project=${encodeURIComponent(project)}&limit=${limit}`,
        );
    }
    markMessageSeen(message_id: number) {
        return this.http("POST", "/api/mark-read", {
            consumer_id: this.agentId,
            message_id,
        });
    }

    // ---- ticket subscriptions + pings ------------------------------------

    subscribeTicket(ticket_id: number) {
        return this.http("POST", "/api/ticket-subscriptions", {
            consumer_id: this.agentId,
            ticket_id,
        });
    }
    unsubscribeTicket(ticket_id: number) {
        return this.http(
            "DELETE",
            `/api/ticket-subscriptions/${ticket_id}?consumer_id=${encodeURIComponent(this.agentId)}`,
        );
    }
    myTicketSubs() {
        return this.http(
            "GET",
            `/api/ticket-subscriptions?consumer_id=${encodeURIComponent(this.agentId)}`,
        );
    }
    listPings(opts: { unreadOnly?: boolean; limit?: number } = {}) {
        const qs = new URLSearchParams({ consumer_id: this.agentId });
        if (opts.unreadOnly) qs.set("unread", "1");
        if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
        return this.http("GET", `/api/pings?${qs.toString()}`);
    }
    markPingsRead(opts: { upToId?: number; all?: boolean }) {
        return this.http("POST", "/api/pings/mark-read", {
            consumer_id: this.agentId,
            up_to_id: opts.upToId,
            all: opts.all === true ? true : undefined,
        });
    }
    pingsCount() {
        return this.http<{ unread: number }>(
            "GET",
            `/api/pings/count?consumer_id=${encodeURIComponent(this.agentId)}`,
        );
    }
    unreadCount(project: string) {
        return this.http<{ count: number }>(
            "GET",
            `/api/unread/count?consumer_id=${encodeURIComponent(this.agentId)}&project=${encodeURIComponent(project)}`,
        );
    }
    myPendingTickets() {
        return this.http(
            "GET",
            `/api/messages?kind=ticket_created&status=pending&by_agent=${encodeURIComponent(this.agentId)}`,
        );
    }

    // ---- admin / decisions ------------------------------------------------

    approve(id: number) {
        return this.http("POST", `/api/messages/${id}/approve`);
    }
    reject(id: number) {
        return this.http("POST", `/api/messages/${id}/reject`);
    }
    edit(id: number, fields: { title?: string; body?: string }) {
        return this.http("POST", `/api/messages/${id}/edit`, fields);
    }
    note(id: number, note: string | null) {
        return this.http("POST", `/api/messages/${id}/note`, { note });
    }
    addRule(rule: {
        decision: "auto" | "review";
        match_project?: string;
        match_kind?: string;
        match_by_agent?: string;
        note?: string;
    }) {
        return this.http("POST", "/api/rules", rule);
    }
    deleteRule(id: number) {
        return this.http("DELETE", `/api/rules/${id}`);
    }

    health() {
        return this.http<{ ok: boolean; ts: string }>("GET", "/api/health");
    }
}

function query(q: Record<string, string | number | undefined>): string {
    const parts = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `?${parts.join("&")}` : "";
}

export function resolveAgentId(cwd = process.cwd()): string {
    if (process.env.AIBALL_AGENT) return process.env.AIBALL_AGENT;
    return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
