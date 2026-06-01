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
import type { ControlEvent } from "./event-bus.js"; // #451: typed control payload

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
        // #508 phase A2 — claude-loop exports AIBALL_NO_CLAIM=1 when the
        // project's `.aiball.yaml` sets `consumer.no_claim: true`. Forward as
        // a header so the upstream's claimable lens picks it up.
        if (process.env.AIBALL_NO_CLAIM === "1") {
            headers["x-aiball-no-claim"] = "1";
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
                throw httpError(method, path, res.status, txt);
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
                            reject(httpError(method, path, status, text));
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

    /**
     * Try to POST a new message; on failure, queue it in the spool.
     *
     * The spool is a *daemon-unreachable* fallback, NOT a catch-all (#389).
     * A deterministic client error (HTTP 4xx — bad request, forbidden close,
     * unknown tag…) would only fail again identically at replay and get
     * silently dumped into spool/failed/, losing the body. So we re-throw 4xx
     * to the caller (the MCP tool surfaces it to the agent synchronously) and
     * spool only on transport failures or 5xx (daemon down / transient).
     */
    async postMessage(
        msg: Record<string, unknown>,
    ): Promise<unknown | SpoolResult> {
        try {
            return await this.http("POST", "/api/messages", msg);
        } catch (e) {
            const status = (e as { status?: number }).status;
            if (typeof status === "number" && status >= 400 && status < 500) {
                throw e;
            }
            return this.spoolDrop(msg);
        }
    }

    /** Per-project subscriber + content stats (« nobody is listening » hint). */
    projectStats(project: string) {
        return this.http("GET", `/api/projects/${encodeURIComponent(project)}/stats`);
    }

    /**
     * Upload raw file bytes to /api/uploads (#387, generalised #694 for
     * text/code/binary in addition to images). Content-addressable: the
     * daemon dedupes by sha256 and returns `{ url, sha256, bytes, content_type }`.
     * Goes over the SAME transport as every other call — UDS (token-less
     * local-trust) when `socketPath` is set, else TCP+token. `name` is an
     * optional original filename (stored as upload metadata). Distinct from
     * `http()` because the body is raw bytes with an arbitrary content-type,
     * not JSON. Roomier timeout than the 2 s probe budget (a 10 MB write
     * can outlast it).
     */
    uploadFile(
        bytes: Buffer,
        contentType: string,
        name?: string,
    ): Promise<{ url: string; sha256: string; bytes: number; content_type: string }> {
        const headers: Record<string, string> = { "content-type": contentType };
        if (this.agentId) headers["x-aiball-consumer"] = this.agentId;
        if (name) headers["x-aiball-upload-name"] = name;
        // #508 phase A2 — propagate the no-claim hint on uploads too (cosmetic
        // but consistent — auth middleware reads the same header in any path).
        if (process.env.AIBALL_NO_CLAIM === "1") {
            headers["x-aiball-no-claim"] = "1";
        }
        const path = "/api/uploads";
        const timeoutMs = Math.max(this.timeoutMs, 15000);
        type UploadResult = { url: string; sha256: string; bytes: number; content_type: string };
        if (this.socketPath) {
            return new Promise<UploadResult>((resolve, reject) => {
                const req = httpRequest(
                    { socketPath: this.socketPath!, path, method: "POST", headers, timeout: timeoutMs },
                    (res: IncomingMessage) => {
                        const chunks: Buffer[] = [];
                        res.on("data", (c) => chunks.push(c as Buffer));
                        res.on("end", () => {
                            const text = Buffer.concat(chunks).toString("utf8");
                            const status = res.statusCode ?? 0;
                            if (status < 200 || status >= 300) {
                                reject(new Error(`POST ${path} → ${status}: ${text}`));
                                return;
                            }
                            try {
                                resolve(JSON.parse(text) as UploadResult);
                            } catch (e) {
                                reject(e);
                            }
                        });
                        res.on("error", reject);
                    },
                );
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy(new Error(`POST ${path} → timeout after ${timeoutMs}ms`));
                });
                req.write(bytes);
                req.end();
            });
        }
        const headersTcp = { ...headers };
        if (this.token) headersTcp["authorization"] = `Bearer ${this.token}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        return fetch(this.url + path, {
            method: "POST",
            headers: headersTcp,
            body: new Uint8Array(bytes),
            signal: ctrl.signal,
        })
            .then(async (res) => {
                if (!res.ok) {
                    const txt = await res.text().catch(() => "");
                    throw new Error(`POST ${path} → ${res.status}: ${txt}`);
                }
                return (await res.json()) as UploadResult;
            })
            .finally(() => clearTimeout(t));
    }

    /**
     * Download a content-addressed upload by its `<sha>.<ext>` filename
     * (#390). GETs `/uploads/<filename>` over the SAME transport as the rest
     * of the client — UDS (local-trust) when `socketPath` is set, else
     * TCP+token. Returns the raw bytes + content-type so a REMOTE loop can
     * read a ticket's attached images, which it can't open as a local
     * `file://`. (`/uploads` is a static mount outside `/api`, so it isn't
     * behind the bearer middleware — the sha256 path is the capability — but
     * we still send the token over TCP; it's ignored there and harmless.)
     * Roomy timeout: an image read can outlast the 2 s probe budget.
     */
    downloadUpload(
        filename: string,
    ): Promise<{ bytes: Buffer; contentType: string }> {
        const path = `/uploads/${filename}`;
        const timeoutMs = Math.max(this.timeoutMs, 15000);
        const headers: Record<string, string> = {};
        if (this.agentId) headers["x-aiball-consumer"] = this.agentId;
        type Dl = { bytes: Buffer; contentType: string };
        if (this.socketPath) {
            return new Promise<Dl>((resolve, reject) => {
                const req = httpRequest(
                    { socketPath: this.socketPath!, path, method: "GET", headers, timeout: timeoutMs },
                    (res: IncomingMessage) => {
                        const chunks: Buffer[] = [];
                        res.on("data", (c) => chunks.push(c as Buffer));
                        res.on("end", () => {
                            const status = res.statusCode ?? 0;
                            const body = Buffer.concat(chunks);
                            if (status < 200 || status >= 300) {
                                reject(httpError("GET", path, status, body.toString("utf8")));
                                return;
                            }
                            resolve({
                                bytes: body,
                                contentType: String(res.headers["content-type"] ?? "application/octet-stream"),
                            });
                        });
                        res.on("error", reject);
                    },
                );
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy(new Error(`GET ${path} → timeout after ${timeoutMs}ms`));
                });
                req.end();
            });
        }
        const headersTcp = { ...headers };
        if (this.token) headersTcp["authorization"] = `Bearer ${this.token}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        return fetch(this.url + path, { method: "GET", headers: headersTcp, signal: ctrl.signal })
            .then(async (res) => {
                if (!res.ok) {
                    const txt = await res.text().catch(() => "");
                    throw httpError("GET", path, res.status, txt);
                }
                const ab = await res.arrayBuffer();
                return {
                    bytes: Buffer.from(ab),
                    contentType: res.headers.get("content-type") ?? "application/octet-stream",
                };
            })
            .finally(() => clearTimeout(t));
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
    getTicket(
        id: number,
        opts: {
            summary?: boolean;
            brief?: boolean;
            tail?: number;
            digest?: boolean;
            digest_limit?: number;
            // #396: paginate/order the full feed (pure full mode only).
            offset?: number;
            limit?: number;
            order?: "asc" | "desc";
        } = {},
    ) {
        const q: Record<string, string | undefined> = {};
        // API default is now summary mode (#B.87). Caller passing
        // {summary: false} explicitly wants the full thread — send full=1.
        // {summary: true} (or omitted) accepts the default; we still send
        // summary=1 when truthy for backward-compat with older daemons.
        if (opts.summary === false) q.full = "1";
        else if (opts.summary === true) q.summary = "1";
        // #396 (david h4gp5z): pagination + order on the full thread. Only
        // meaningful in pure full mode — brief/digest have their own shapes.
        if (opts.summary === false && !opts.brief && !opts.digest) {
            if (typeof opts.offset === "number" && opts.offset > 0) q.offset = String(Math.floor(opts.offset));
            if (typeof opts.limit === "number" && opts.limit > 0) q.limit = String(Math.floor(opts.limit));
            if (opts.order === "desc") q.order = "desc";
        }
        // #B.130 phase 2 + #B.21X (pivot-cut): brief returns the thread
        // shaped around the latest summary_until pivot — drops the
        // already-summarized prefix, keeps full bodies after the pivot.
        // Falls back to the legacy tail-keep when no summary exists in
        // the thread. #B.202: `tail=N` only matters in that fallback.
        if (opts.brief) {
            q.full = "1";
            q.brief = "1";
            if (typeof opts.tail === "number" && opts.tail > 1) {
                q.tail = String(Math.floor(opts.tail));
            }
        }
        // #B.21X: digest = ordered list of summary_until snapshots
        // (lossy by design, bird's-eye scan). Ignored if brief is set.
        if (opts.digest && !opts.brief) {
            q.digest = "1";
            if (typeof opts.digest_limit === "number" && opts.digest_limit > 0) {
                q.digest_limit = String(Math.floor(opts.digest_limit));
            }
        }
        return this.http("GET", `/api/tickets/${id}${query(q)}`);
    }
    listProjects() {
        return this.http("GET", "/api/projects");
    }
    /**
     * Explicitly register a project (#B.216 phase A pass 2). The CLI's
     * `aiball project init` and the Web UI's "Create project" button
     * both go through here. Server returns 201 + the inserted row, or
     * 409 if the name is already taken.
     */
    createProject(name: string, opts: {
        display_name?: string;
        description?: string;
        created_by?: string;
    } = {}) {
        return this.http<{
            name: string;
            display_name: string | null;
            description: string | null;
            created_at: string;
            created_by: string | null;
        }>("POST", "/api/projects", {
            name,
            display_name: opts.display_name,
            description: opts.description,
            created_by: opts.created_by ?? this.agentId,
        });
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
     * Move a ticket (whole thread) to another project (#294). Reporter-or-
     * human only (enforced daemon-side via the x-aiball-consumer identity).
     */
    moveTicket(ticket_id: number, project: string) {
        return this.http("POST", `/api/tickets/${ticket_id}/move`, { project });
    }
    /**
     * #418: assign / claim a ticket. Pass `assignee` to PUSH it onto another
     * consumer (human/moderator only); omit it (or pass your own id) to CLAIM it
     * for yourself. A live assignment narrows the ticket out of OTHER consumers'
     * actionable pool until it expires (assign_window_sec), is released, or the
     * ticket closes — multi-agent anti-collision.
     */
    assignTicket(ticket_id: number, assignee?: string) {
        return this.http<{ ticket_id: number; assignee: string | null; claimant: string | null; assigned_by: string; is_claim: boolean }>(
            "POST",
            `/api/tickets/${ticket_id}/assign`,
            assignee ? { assignee } : {},
        );
    }
    /** #418: release a ticket's assignment / claim — back to the shared pool. */
    releaseTicket(ticket_id: number) {
        return this.http<{ ticket_id: number; released: boolean }>(
            "POST",
            `/api/tickets/${ticket_id}/release`,
            {},
        );
    }
    /**
     * Create or change a typed relation (#275) from `ticket_id` → `target`.
     * Append-only: posting the same active kind is a server-side no-op;
     * `kind="ignored"` removes the edge (tombstone). Mirrors
     * POST /api/tickets/:id/relations. The daemon enforces self-relation,
     * kind validity, target existence, reporter-or-human permission, the
     * lineage cycle guard, and idempotency.
     */
    relate(ticket_id: number, target_ticket_id: number, kind: string) {
        return this.http<{
            ticket_id: number;
            event_id: number | null;
            noop?: boolean;
            relations: unknown[];
        }>("POST", `/api/tickets/${ticket_id}/relations`, { target_ticket_id, kind });
    }
    /**
     * Same endpoint with `detailed=1` — returns objects with counts
     * (ticket_count, open_count, pending_count, last_activity…) instead
     * of bare names. Used by poll() to surface per-project workload.
     */
    listProjectsDetailed(opts?: { landscape?: boolean }) {
        // #379: pass `landscape=1` to also get landscape_hash + landscape_last_activity
        // per project (the drained-strategy reset/dedup primitive). Off by default —
        // only the claude-loop timer asks for it, sidebar polls don't pay the O(N).
        const ls = opts?.landscape ? "&landscape=1" : "";
        return this.http<Array<{
            name: string;
            last_activity: string;
            ticket_count: number;
            comment_count: number;
            pending_count: number;
            open_count?: number;
            /** Subset of `open_count` excluding agent-resolved tickets
             *  (#B.119) AND, since #265, tickets where THIS agent
             *  authored the latest content (in the human's court). Used
             *  by the autopoll hook so the agent isn't nagged about
             *  tickets already awaiting the human. */
            actionable_count?: number;
            snoozed_count?: number;
            resolved_count?: number;
            /** #379: open-landscape signature (only set when landscape=1). */
            landscape_hash?: string;
            /** #379: max(last_actor_at) over open tickets (only when landscape=1). */
            landscape_last_activity?: string | null;
            /** #393: a claude-loop with a known root has worked this project. */
            local?: boolean;
            /** #393: the loop root(s) known for this project (from consumers.cwd). */
            roots?: string[];
            // #265: scope to our own agent id so the actionable_count is
            // "actionable for me" (the conversational gate is per-consumer).
        }>>("GET", `/api/projects?detailed=1&consumer_id=${encodeURIComponent(this.agentId)}${ls}`);
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

    /** #397: fetch a single consumer (incl. `micro_prompt`). Used by the wake
     *  builder to inject `{consumer_prompt}` into the relance prompt. */
    getConsumer(id: string) {
        return this.http<{ consumer_id: string; micro_prompt?: string | null }>(
            "GET",
            `/api/consumers/${encodeURIComponent(id)}`,
        );
    }

    /** #404: push a turn's token-usage delta onto a ticket (additive). Called
     *  best-effort by the Stop-hook's token-capture; failures are swallowed. */
    postTokenUsage(ticketId: number, u: { in: number; out: number; cacheW: number; cacheR: number }) {
        return this.http(
            "POST",
            `/api/tickets/${ticketId}/token-usage`,
            { in: u.in, out: u.out, cache_w: u.cacheW, cache_r: u.cacheR },
        );
    }

    /** #634 david `svzkpw` — push a turn's token-usage delta onto a PROJECT
     *  (no-marker fallback path in the Stop-hook). Additive ; best-effort. */
    postProjectTokenUsage(project: string, u: { in: number; out: number; cacheW: number; cacheR: number }) {
        return this.http(
            "POST",
            `/api/projects/${encodeURIComponent(project)}/token-usage`,
            { in: u.in, out: u.out, cache_w: u.cacheW, cache_r: u.cacheR },
        );
    }

    /**
     * #B.177 B1: push the current claude-loop state for this consumer
     * (own-state only — the daemon refuses cross-consumer pushes).
     * Best-effort: failures are not surfaced to the caller, the timer
     * heartbeats again on the next tick.
     */
    pushState(
        state: "busy" | "idle" | "boot",
        human?: boolean,
        humanWord?: "stop" | "wait" | "boot" | "loop",
        cwd?: string,
        project?: string,
    ) {
        const body: { state: string; human?: boolean; human_word?: string; cwd?: string; project?: string } = { state };
        if (human !== undefined) body.human = human;
        if (humanWord !== undefined) body.human_word = humanWord;
        // #393: the loop's root, so the daemon can mark the project "local".
        if (cwd !== undefined) body.cwd = cwd;
        // #393 (Option A): the loop's project → exact root↔project attribution.
        if (project !== undefined) body.project = project;
        return this.http<{ consumer_id: string; state: string; human?: boolean; human_word?: string }>(
            "PUT",
            `/api/consumers/${encodeURIComponent(this.agentId)}/state`,
            body,
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
        // #442/#451: out-of-band control events (remote kill / raw-prompt
        // injection) on the same stream.
        onControl?: (payload: ControlEvent) => void;
        onError?: (err: Error) => void;
    }): () => void {
        const path = `/api/events?consumer_id=${encodeURIComponent(this.agentId)}`;
        // Same UDS-or-TCP split as the rest of the client. UDS is
        // auth-free (the daemon trusts same-uid callers); TCP needs
        // the bearer token. SSE works identically on both transports.
        const headers: Record<string, string> = { "x-aiball-consumer": this.agentId };
        let reqOpts: import("node:http").RequestOptions;
        if (this.socketPath) {
            reqOpts = { socketPath: this.socketPath, path, method: "GET", headers };
        } else {
            const u = new URL(this.url);
            if (this.token) headers["authorization"] = `Bearer ${this.token}`;
            reqOpts = {
                host: u.hostname,
                port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
                path,
                method: "GET",
                headers,
            };
        }
        const req = httpRequest(reqOpts, (res: IncomingMessage) => {
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
                    } else if (evName === "control" && handlers.onControl) {
                        handlers.onControl(payload as ControlEvent);
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
    /**
     * #697 F5 — pending plan / resolution decisions on tickets THIS agent
     * reports, waiting for accept / reject. Distinct from `myPendingTickets`,
     * which surfaces drafts of THIS agent's still in moderation (waiting on a
     * moderator). `myArbitrage` is the inverse : work waiting on THIS agent.
     */
    myArbitrage() {
        return this.http<{
            decisions: Array<{
                comment_id: number;
                comment_hashid: string | null;
                ticket_id: number;
                ticket_title: string;
                ticket_project: string;
                decision_kind: "plan" | "resolution";
                proposed_by: string | null;
                created_at: string;
                summary_until: string | null;
            }>;
        }>("GET", `/api/decisions/mine`);
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
            priority?: string | null;
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
        return this.http<{ ok: boolean; ts: string; version?: string }>("GET", "/api/health");
    }

    /**
     * #394 local node probe — never relayed (mounted before the proxy relay in
     * app.ts). Tells whether THIS daemon is a proxy node and, if so, the
     * upstream it relays to. `/api/health` can't answer this: in proxy mode it
     * relays and reports the REMOTE.
     */
    node() {
        return this.http<{ ok: boolean; proxy: boolean; upstream: string | null }>("GET", "/api/node");
    }
}

/**
 * Build an Error carrying the HTTP `status`, so callers (notably
 * postMessage's spool fallback, #389) can tell a deterministic client
 * error (4xx — retrying won't help) from a transport/server failure
 * (connection refused, timeout, 5xx — worth spooling for replay).
 */
function httpError(
    method: string,
    path: string,
    status: number,
    body: string,
): Error {
    const err = new Error(`${method} ${path} → ${status}: ${body}`) as Error & {
        status?: number;
    };
    err.status = status;
    return err;
}

function query(q: Record<string, string | number | undefined>): string {
    const parts = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The user's working directory, NOT the install dir. The bash
 * launcher does `cd "$ROOT"` before exec'ing tsx (so `npx` resolves
 * deps against the install tree), which makes `process.cwd()` point
 * at the install dir. AIBALL_CWD is set by the wrapper to preserve
 * the invoker's PWD — config resolution must walk up from there, not
 * from the install dir (else every `aiball` call reads the install
 * dir's own `.aiball.yaml`, masking the user's project). #B.207
 * david: this was making `aiball whoami` return claude-aiball-dev /
 * aiball from any cwd because the install's yaml carries those.
 */
function resolveUserCwd(): string {
    return process.env.AIBALL_CWD ?? process.cwd();
}

/**
 * Resolve default project: env > .aiball.yaml > .mcp.json. Returns
 * null when nothing provides a project name — callers that NEED a
 * project (most ticket ops) will throw via `resolveProject()`. The
 * `<basename>-claude` default for agent isn't mirrored here because
 * project name without explicit user intent (yaml or env) tends to
 * be ambiguous (e.g. running `aiball ticket new` from a tools dir).
 */
export function resolveDefaultProject(cwd = resolveUserCwd()): string | null {
    if (process.env.AIBALL_PROJECT) return process.env.AIBALL_PROJECT;
    try {
        const cfg = loadConfig(cwd);
        return cfg.consumer.project ?? null;
    } catch {
        return null;
    }
}

export function resolveAgentId(cwd = resolveUserCwd()): string {
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
