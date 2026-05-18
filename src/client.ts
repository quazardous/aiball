/**
 * Thin HTTP client to talk to the aiball daemon, with the same spool-fallback
 * semantics as the bash CLI: if POST /messages can't reach the daemon, drop a
 * JSON file in the spool directory so the daemon picks it up later.
 *
 * Transport: TCP (`url`) is the default; pass `socketPath` (or set
 * `AIBALL_SOCK`) to route through a Unix domain socket instead. UDS is
 * the preferred transport for same-host CLI/MCP — the daemon enforces
 * trust at the OS level (chmod 600 on the socket file) so no bearer
 * token is needed. Token + URL remain the only path for remote clients
 * if the architecture ever grows beyond local.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./autopoll/config.js";
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

export interface ClientOptions {
    url?: string;
    home?: string;
    timeoutMs?: number;
    agentId?: string;
    defaultProject?: string;
    /** Bearer token (#B.94). Defaults to `$AIBALL_TOKEN` env. Ignored when `socketPath` is set. */
    token?: string;
    /**
     * Unix domain socket path. When set, requests bypass TCP and route
     * through `http.request({socketPath})`. Defaults to `$AIBALL_SOCK`.
     * Same-uid clients use this for token-less local access.
     */
    socketPath?: string;
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
    readonly token: string | null;
    readonly socketPath: string | null;

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
            opts.defaultProject ?? resolveDefaultProject();
        // UDS preferred when present — auth-free. Falls back to TCP+token.
        const envSock = process.env.AIBALL_SOCK;
        this.socketPath =
            opts.socketPath ?? (envSock && envSock !== "" ? envSock : null);
        this.token = opts.token ?? process.env.AIBALL_TOKEN ?? null;
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
        const headers: Record<string, string> = {};
        if (body) headers["content-type"] = "application/json";
        if (this.agentId) headers["x-aiball-consumer"] = this.agentId;
        // Bearer is irrelevant over UDS (server bypasses auth there).
        if (!this.socketPath && this.token) {
            headers["authorization"] = `Bearer ${this.token}`;
        }
        const payload = body ? JSON.stringify(body) : undefined;
        if (this.socketPath) {
            return this.httpUds<T>(method, path, headers, payload);
        }
        return this.httpTcp<T>(method, path, headers, payload);
    }

    private async httpTcp<T>(
        method: string,
        path: string,
        headers: Record<string, string>,
        payload: string | undefined,
    ): Promise<T> {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.url + path, {
                method,
                headers,
                body: payload,
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

    private httpUds<T>(
        method: string,
        path: string,
        headers: Record<string, string>,
        payload: string | undefined,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = httpRequest(
                {
                    socketPath: this.socketPath!,
                    path,
                    method,
                    headers,
                    timeout: this.timeoutMs,
                },
                (res: IncomingMessage) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c) => chunks.push(c as Buffer));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const status = res.statusCode ?? 0;
                        if (status < 200 || status >= 300) {
                            reject(new Error(`${method} ${path} → ${status}: ${text}`));
                            return;
                        }
                        const ct = res.headers["content-type"] ?? "";
                        if (typeof ct === "string" && ct.includes("application/json")) {
                            try {
                                resolve(JSON.parse(text) as T);
                            } catch (e) {
                                reject(e);
                            }
                            return;
                        }
                        resolve(undefined as unknown as T);
                    });
                    res.on("error", reject);
                },
            );
            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy(new Error(`${method} ${path} → timeout after ${this.timeoutMs}ms`));
            });
            if (payload) req.write(payload);
            req.end();
        });
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

    /** Flip a ticket's broadcast flag via the dedicated PATCH endpoint. */
    setTicketBroadcast(ticket_id: number, broadcast: boolean) {
        return this.http("PATCH", `/api/tickets/${ticket_id}`, { broadcast });
    }

    /** Per-project subscriber + content stats (« nobody is listening » hint). */
    projectStats(project: string) {
        return this.http("GET", `/api/projects/${encodeURIComponent(project)}/stats`);
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

    search(opts: {
        query: string;
        project?: string;
        open?: boolean;
        intent?: string;
        limit?: number;
        include_postponed?: boolean;
    }) {
        const q: Record<string, string | undefined> = { q: opts.query };
        if (opts.project) q.project = opts.project;
        if (opts.open) q.open = "1";
        if (opts.intent) q.intent = opts.intent;
        if (opts.limit !== undefined) q.limit = String(opts.limit);
        if (opts.include_postponed) q.include_postponed = "1";
        return this.http("GET", `/api/search${query(q)}`);
    }
    listMessages(q: Record<string, string | number | undefined> = {}) {
        return this.http("GET", `/api/messages${query(q)}`);
    }
    getMessage(id: number) {
        return this.http("GET", `/api/messages/${id}`);
    }
    listTickets(q: Record<string, string | undefined> = {}) {
        return this.http("GET", `/api/tickets${query(q)}`);
    }
    getTicket(id: number, opts: { summary?: boolean; brief?: boolean } = {}) {
        const q: Record<string, string | undefined> = {};
        // API default is now summary mode (#B.87). Caller passing
        // {summary: false} explicitly wants the full thread — send full=1.
        // {summary: true} (or omitted) accepts the default; we still send
        // summary=1 when truthy for backward-compat with older daemons.
        if (opts.summary === false) q.full = "1";
        else if (opts.summary === true) q.summary = "1";
        // #B.130 phase 2: brief mode = full thread but per-comment bodies
        // replaced by `summary_line` (meta.summary) except the last one.
        // Implies full=1 server-side.
        if (opts.brief) {
            q.full = "1";
            q.brief = "1";
        }
        return this.http("GET", `/api/tickets/${id}${query(q)}`);
    }
    listProjects() {
        return this.http("GET", "/api/projects");
    }
    /**
     * Snooze a ticket until the given ISO8601 timestamp (per #B.329).
     * The ticket is hidden from the open inbox until the deadline; the
     * daemon's reveal cron clears the field at that point.
     */
    postponeTicket(ticket_id: number, until: string) {
        return this.http<{ ticket_id: number; postponed_until: string }>(
            "POST",
            `/api/tickets/${ticket_id}/postpone`,
            { until },
        );
    }
    unsnoozeTicket(ticket_id: number) {
        return this.http<{ ticket_id: number; postponed_until: null }>(
            "POST",
            `/api/tickets/${ticket_id}/unsnooze`,
            {},
        );
    }
    /**
     * Same endpoint with `detailed=1` — returns objects with counts
     * (ticket_count, open_count, pending_count, last_activity…) instead
     * of bare names. Used by poll() to surface per-project workload.
     */
    listProjectsDetailed() {
        return this.http<Array<{
            name: string;
            last_activity: string;
            ticket_count: number;
            comment_count: number;
            pending_count: number;
            open_count?: number;
            /** Subset of `open_count` excluding agent-resolved tickets
             *  (#B.119). Used by the autopoll hook so the agent
             *  isn't nagged about tickets already in the human's court. */
            actionable_count?: number;
            snoozed_count?: number;
            resolved_count?: number;
        }>>("GET", "/api/projects?detailed=1");
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

    subscribe(project: string, catchup = false, role?: "owner" | "follower") {
        return this.http("POST", "/api/subscriptions", {
            consumer_id: this.agentId,
            project,
            catchup,
            role,
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

    /**
     * #B.177 B1: push the current claude-loop state for this consumer
     * (own-state only — the daemon refuses cross-consumer pushes).
     * Best-effort: failures are not surfaced to the caller, the timer
     * heartbeats again on the next tick.
     */
    pushState(state: "busy" | "idle" | "boot") {
        return this.http<{ consumer_id: string; state: string }>(
            "PUT",
            `/api/consumers/${encodeURIComponent(this.agentId)}/state`,
            { state },
        );
    }

    /**
     * Open a long-lived SSE stream for live ping notifications
     * (#B.148 phase B). Each `event: ping` from the daemon invokes
     * the handler with the parsed JSON payload (typically
     * `{ticket_id}` or `{comment_id}`). Returns an `unsubscribe`
     * function the caller invokes to tear down the connection.
     *
     * UDS-only (the daemon's SSE endpoint is local-trust). TCP-fallback
     * isn't wired here — remote SSE is a separate concern when/if the
     * daemon grows beyond local.
     *
     * Behavior:
     *   - Sends a `hello` event at connect time; ignored unless caller
     *     opts in via the `onHello` callback (for badge bootstrap).
     *   - No built-in reconnect — caller decides retry strategy. The
     *     claude-loop timer (#B.148 phase C) wraps this with backoff.
     *   - `onError` fires on socket / parse failures; if absent, the
     *     stream just teardown silently. Always pair with reconnect
     *     logic upstream for long-lived consumers.
     */
    subscribeEvents(handlers: {
        onPing: (payload: { ticket_id?: number; comment_id?: number; comment_hashid?: string; intent?: "panic" | "request" | "question" | "fyi" }) => void;
        onHello?: (payload: { consumer_id: string; unread: number }) => void;
        onError?: (err: Error) => void;
    }): () => void {
        if (!this.socketPath) {
            throw new Error("subscribeEvents requires UDS (AIBALL_SOCK)");
        }
        const path = `/api/events?consumer_id=${encodeURIComponent(this.agentId)}`;
        const req = httpRequest({
            socketPath: this.socketPath,
            path,
            method: "GET",
            headers: { "x-aiball-consumer": this.agentId },
        }, (res: IncomingMessage) => {
            if ((res.statusCode ?? 0) >= 400) {
                handlers.onError?.(new Error(`SSE ${path} → ${res.statusCode}`));
                req.destroy();
                return;
            }
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                buf += chunk;
                // SSE frames are separated by a blank line. Process
                // every complete frame; the tail (incomplete) stays
                // in `buf` for the next chunk.
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    let evName = "message";
                    let dataStr = "";
                    for (const line of frame.split("\n")) {
                        if (line.startsWith(":")) continue;
                        if (line.startsWith("event:")) evName = line.slice(6).trim();
                        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
                    }
                    if (!dataStr) continue;
                    let payload: unknown;
                    try { payload = JSON.parse(dataStr); }
                    catch { continue; }
                    if (evName === "ping") {
                        handlers.onPing(payload as { ticket_id?: number; comment_id?: number; comment_hashid?: string; intent?: "panic" | "request" | "question" | "fyi" });
                    } else if (evName === "hello" && handlers.onHello) {
                        handlers.onHello(payload as { consumer_id: string; unread: number });
                    }
                }
            });
            res.on("end", () => handlers.onError?.(new Error("SSE stream closed by server")));
            res.on("error", (e) => handlers.onError?.(e));
        });
        req.on("error", (e) => handlers.onError?.(e));
        req.end();
        return () => {
            try { req.destroy(); } catch { /* already torn */ }
        };
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
    /**
     * Pending comments authored by this agent. Symmetric to
     * myPendingTickets() — both surface in poll() so the agent sees
     * its own submissions blocked in moderation regardless of kind
     * (per #B.69).
     */
    myPendingComments() {
        return this.http(
            "GET",
            `/api/messages?kind=comment_added&status=pending&by_agent=${encodeURIComponent(this.agentId)}`,
        );
    }
    /**
     * First + last non-rejected ticket in scope — used by the slim
     * `poll()` (per #B.68). Cross-project by default; pass project to
     * restrict. include_snoozed widens the scope.
     */
    bookends(opts: { project?: string; includeSnoozed?: boolean } = {}) {
        const qs = new URLSearchParams();
        if (opts.project) qs.set("project", opts.project);
        if (opts.includeSnoozed) qs.set("include_snoozed", "1");
        const q = qs.toString();
        return this.http<{ first: unknown; last: unknown }>(
            "GET",
            `/api/tickets/bookends${q ? "?" + q : ""}`,
        );
    }
    myPendingCount() {
        return this.http<{ count: number }>(
            "GET",
            `/api/my-pending/count?by_agent=${encodeURIComponent(this.agentId)}`,
        );
    }

    // ---- admin / decisions ------------------------------------------------

    approve(id: number) {
        return this.http("POST", `/api/messages/${id}/approve`);
    }
    reject(id: number) {
        return this.http("POST", `/api/messages/${id}/reject`);
    }
    edit(
        id: number,
        fields: {
            title?: string | null;
            body?: string | null;
            summary?: string | null;
            intent?: string | null;
        },
    ) {
        return this.http("POST", `/api/messages/${id}/edit`, fields);
    }
    /**
     * Overwrite the tag set on a message (ticket or comment). Pass
     * tag NAMES — the daemon resolves to ids via getTagByName.
     * Unknown names bubble up as 400.
     */
    setMessageTags(id: number, tag_names: string[], set_by?: string) {
        return this.http("PUT", `/api/messages/${id}/tags`, {
            tag_ids: tag_names,
            set_by: set_by ?? null,
        });
    }
    note(id: number, note: string | null) {
        return this.http("POST", `/api/messages/${id}/note`, { note });
    }
    listRules() {
        return this.http("GET", "/api/rules");
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
    toggleRule(id: number, enabled: boolean) {
        return this.http("PATCH", `/api/rules/${id}`, { enabled });
    }
    /**
     * Bulk mark-read by project. Pass either upToId or all=true.
     * Mirrors the bash `aiball mark-read` semantics.
     */
    markReadProject(opts: { project: string; upToId?: number; all?: boolean }) {
        const body: Record<string, unknown> = {
            consumer_id: this.agentId,
            project: opts.project,
        };
        if (opts.all === true) body.all = true;
        else if (opts.upToId !== undefined) body.up_to_id = opts.upToId;
        return this.http("POST", "/api/mark-read", body);
    }

    /**
     * Upsert a consumer row (#B.79). Used by the sandbox launcher to
     * pre-register the autonomous agent with `kind: "sandbox"` so the
     * Consumers panel can distinguish loop agents from interactive ones
     * (#B.103). No-op on the daemon side if the row already exists with
     * the same shape.
     */
    upsertConsumer(input: {
        consumer_id: string;
        kind?: "human" | "agent" | "sandbox";
        display_name?: string | null;
        enabled?: boolean;
        note?: string | null;
    }) {
        return this.http("POST", "/api/consumers", input);
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

/**
 * Resolve default project: env > .aiball.yaml > .mcp.json. Returns
 * null when nothing provides a project name — callers that NEED a
 * project (most ticket ops) will throw via `resolveProject()`. The
 * `<basename>-claude` default for agent isn't mirrored here because
 * project name without explicit user intent (yaml or env) tends to
 * be ambiguous (e.g. running `aiball ticket new` from a tools dir).
 */
export function resolveDefaultProject(cwd = process.cwd()): string | null {
    if (process.env.AIBALL_PROJECT) return process.env.AIBALL_PROJECT;
    try {
        const cfg = loadConfig(cwd);
        return cfg.consumer.project ?? null;
    } catch {
        return null;
    }
}

export function resolveAgentId(cwd = process.cwd()): string {
    // loadConfig does the full chain (env > .aiball.yaml > .mcp.json
    // > `<project>-claude` default), so the agent field is always
    // populated here. sha256(cwd) survives only as the
    // never-throws fallback (#B.154 david: unified resolution).
    try {
        const cfg = loadConfig(cwd);
        if (cfg.consumer.agent) return cfg.consumer.agent;
    } catch { /* fall through */ }
    return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
