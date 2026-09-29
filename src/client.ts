/**
 * The client of the aiball daemon the MCP server, the CLI and claude-loop
 * share. #3067 — it calls the core's methods over the bus (one connection per
 * process, `call`); the routes that are not methods yet still go over HTTP.
 * Same spool-fallback
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
import type { AgentBar } from "./agent-bar.js";
import type { DecisionKind } from "./ticket-transitions.js";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./autopoll/config.js";
import { isLoopback, readMachineSecret } from "./machine-secret.js";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { ControlEvent } from "./event-bus.js"; // #451: typed control payload
import { BusClient, BusError } from "./bus-client.js";

/** #2586 — `GET /api/version`; see src/update-check.ts. */
export interface VersionInfo {
    running: string;
    installed: string;
    latest: string | null;
    release_url: string | null;
    checked_at: string | null;
    error: string | null;
    update_available: boolean;
    restart_needed: boolean;
    check_disabled: boolean;
    mode: "release" | "edge" | "dev" | "unknown";
}

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
    /** #2652 — protocol features this client knows, sent as `x-aiball-client`. */
    features?: string[];
}

export interface SpoolResult {
    queued: true;
    file: string;
}

/** #2198 — what poll() asks the daemon for when it lists my pending posts. */
export interface PendingListOpts {
    project?: string | null;
    summary?: boolean;
    limit?: number;
}

export class AiballClient {
    readonly url: string;
    readonly home: string;
    readonly spoolDir: string;
    readonly features: string[];
    readonly outboxDir: string;
    readonly timeoutMs: number;
    readonly agentId: string;
    readonly defaultProject: string | null;
    readonly token: string | null;
    readonly socketPath: string | null;
    /** The multi-agent role this client states (`x-aiball-role`), or null (lead). */
    readonly role: "lead" | "crew" | null;
    /** Whether this client asks not to claim (`x-aiball-no-claim`). */
    readonly noClaim: boolean;

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
        this.token = opts.token ?? process.env.AIBALL_TOKEN ?? localMachineSecret(this.socketPath, this.url, this.home);
        this.features = opts.features ?? [];
        // The folder's `.aiball.yaml` speaks for the folder's own agent only: a
        // client built for another agent (an explicit agentId) keeps to the env.
        const standing = resolveConsumerStanding(process.env, opts.agentId === undefined ? resolveUserCwd() : null);
        this.role = standing.role;
        this.noClaim = standing.noClaim;
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

    /**
     * What this client says of itself, on every HTTP request and when the bus
     * connection opens: who, and the hints below. No auth, no content type.
     */
    private identityHeaders(): Record<string, string> {
        const headers: Record<string, string> = {};
        if (this.agentId) headers["x-aiball-consumer"] = this.agentId;
        // #508 phase A2 — the no-claim hint, so the upstream's claimable lens
        // picks it up. Resolved like the agent id (env, else .aiball.yaml).
        if (this.noClaim) headers["x-aiball-no-claim"] = "1";
        // #1435 slice 5 — the multi-agent role, which the daemon persists on the
        // consumer (visible in the UI). Mirrors the no-claim hint.
        if (this.role) headers["x-aiball-role"] = this.role;
        // #2099 — say what this machine is, so a ticket filed from here can be
        // tagged with it. The daemon cannot deduce it: behind a proxy node the
        // connection carries the NODE's platform, not the agent's. Same shape
        // as the two hints above — the client states a fact about itself, the
        // daemon decides what to do with it (a closed three-value map).
        headers["x-aiball-platform"] = process.platform;
        // #2652 — what this client knows of the protocol (the daemon only
        // enforces a newly required field on a client that declares it).
        if (this.features.length) headers["x-aiball-client"] = this.features.join(",");
        return headers;
    }

    private busConnection: Promise<BusClient> | null = null;

    /**
     * #3067 — the bus connection, opened on the first call and opened again
     * after the daemon closed it (a restart). It holds the process only while
     * a call waits: a CLI command or a hook exits without closing it.
     */
    private bus(): Promise<BusClient> {
        if (this.busConnection) return this.busConnection;
        const headers = this.identityHeaders();
        const opening = BusClient.connect(this.socketPath
            ? { socket: this.socketPath, headers, unrefWhenIdle: true }
            // Bearer is irrelevant over UDS (server bypasses auth there).
            : { url: this.url, token: this.token ?? undefined, headers, unrefWhenIdle: true });
        this.busConnection = opening;
        const forget = () => { if (this.busConnection === opening) this.busConnection = null; };
        opening.then((c) => { void c.closed().then(forget); }, forget);
        return opening;
    }

    /**
     * #3067 — call one of the core's methods over the bus. Errors keep the
     * shape HTTP gave them (`status`, the refusal body in the message), so a
     * caller cannot tell the transports apart:
     * - the daemon refused: `status` and `{ error, code, details }`;
     * - it could not be reached, or the call was never sent: retried, as #855
     *   retries a daemon being restarted (nothing ran, a replay is safe);
     * - the connection dropped while the call was in flight: not retried (it
     *   may have run), no `status`, so `postMessage` spools it as it spools a
     *   request cut after its bytes left.
     */
    protected call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        return withRetry(async () => {
            const bus = await this.bus().catch((e: Error & { code?: string }) => {
                // The daemon answered the opening, and refused it (a token it does not know…).
                if (e instanceof BusError) throw httpError("bus", method, e.status, JSON.stringify({ error: e.message, code: e.code }));
                throw transportError(e, "bus", method, this.socketPath ? `unix:${this.socketPath}` : this.url);
            });
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_r, reject) => {
                timer = setTimeout(() => reject(new Error(`bus ${method} → timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
                timer.unref();
            });
            try {
                return await Promise.race([bus.call<T>(method, params), timeout]);
            } catch (e) {
                if (!(e instanceof BusError)) throw e;
                if (e.code === "UNSENT") {
                    this.busConnection = null;
                    throw Object.assign(new Error(`bus ${method}: ${e.message}`), { code: "ECONNRESET" });
                }
                if (e.code === "UNAVAILABLE" && e.rpcCode >= 1000) {
                    throw Object.assign(new Error(`bus ${method}: ${e.message}, while the call was in flight`), { code: "EBUSCLOSED" });
                }
                const body = { error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) };
                throw httpError("bus", method, e.status, JSON.stringify(body));
            } finally {
                clearTimeout(timer);
            }
        });
    }

    private async http<T = unknown>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const headers = this.identityHeaders();
        if (body) headers["content-type"] = "application/json";
        // Bearer is irrelevant over UDS (server bypasses auth there).
        if (!this.socketPath && this.token) {
            headers["authorization"] = `Bearer ${this.token}`;
        }
        const payload = body ? JSON.stringify(body) : undefined;
        // #855 — retry-with-backoff on transient daemon-down errors so
        // an `aiball restart` (or tsx-watch reload) doesn't kill in-flight
        // tool calls in cascade. Retriable = the request never reached or
        // wasn't processed by the daemon (ECONNREFUSED / ENOENT / 502-504
        // / pre-response socket hang up). NOT retried : 4xx (deterministic),
        // 5xx ≠ 502-504 (logic error), or timeout once bytes have flown
        // (risk of double-write on POST).
        return withRetry(() => {
            if (this.socketPath) {
                return this.httpUds<T>(method, path, headers, payload);
            }
            return this.httpTcp<T>(method, path, headers, payload);
        });
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
            req.on("error", (e: Error & { code?: string }) => reject(transportError(e, method, path, `unix:${this.socketPath}`)));
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
        // #3245 — one key per write, drawn before the first attempt: the spool
        // keeps it, so a replay of a write that had gone through is answered
        // with the message it made, not posted twice.
        msg = { ...msg, idempotency_key: msg.idempotency_key ?? randomUUID() };
        try {
            return await this.call("message.post", msg);
        } catch (e) {
            const status = (e as { status?: number }).status;
            if (typeof status === "number" && status >= 400 && status < 500) {
                throw e;
            }
            return this.spoolDrop(msg);
        }
    }

    // =================================================================
    //  #2109 — the ticket's payload zone
    // =================================================================

    /** The FILTERED view: keys always, values only where the schema says. */
    ticketPayload(ticketId: number) {
        return this.call("ticket.payload", { id: ticketId });
    }

    /** Deposit or replace. `publicKeys` names the keys that are NOT secret. */
    setTicketPayload(ticketId: number, payload: Record<string, unknown>, publicKeys: string[]) {
        return this.call("ticket.set_payload", { id: ticketId, payload, schema: publicKeys });
    }

    /**
     * The values themselves — the deliberate gesture.
     *
     * POST, not GET: a secret should not sit in a URL that proxies log and
     * shells keep in history.
     */
    dumpTicketPayload(ticketId: number) {
        return this.call("ticket.dump_payload", { id: ticketId });
    }

    /** Revoke: destroy the values, keep the trace that they existed. */
    revokeTicketPayload(ticketId: number) {
        return this.call("ticket.revoke_payload", { id: ticketId });
    }

    /**
     * #2164 — the three `_status` counters in ONE round-trip.
     *
     * They used to be three calls wrapped in `Promise.all`, which parallelises
     * nothing against a single-threaded daemon: benchmarked at ~30 ms added to
     * every MCP tool response, almost all of it queueing.
     */
    microStatusCounts(project: string | null) {
        return this.call<{ unread_project: number; unread_pings: number; my_pending: number }>(
            "consumer.micro_status",
            { consumer_id: this.agentId, ...(project ? { project } : {}) },
        );
    }

    /** Per-project subscriber + content stats (« nobody is listening » hint). */
    projectStats(project: string) {
        return this.call("project.stats", { name: project });
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
        if (this.noClaim) headers["x-aiball-no-claim"] = "1";
        if (this.role) headers["x-aiball-role"] = this.role;
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
        since?: string;
    }) {
        const q: Record<string, string | undefined> = { q: opts.query };
        if (opts.project) q.project = opts.project;
        if (opts.open) q.open = "1";
        if (opts.intent) q.intent = opts.intent;
        if (opts.limit !== undefined) q.limit = String(opts.limit);
        if (opts.include_postponed) q.include_postponed = "1";
        if (opts.since) q.since = opts.since;
        return this.call("message.search", params(q));
    }
    /** #1992 — what to read before touching a ticket, from the compiled graph. */
    graphNeighbors(opts: { ticket_id: number; min_weight?: number; limit?: number }) {
        const q: Record<string, string | undefined> = { ticket_id: String(opts.ticket_id) };
        if (opts.min_weight !== undefined) q.min_weight = String(opts.min_weight);
        if (opts.limit !== undefined) q.limit = String(opts.limit);
        return this.call("graph.neighbors", params(q));
    }
    /** #1992 — the hygiene report. Candidates only; it never acts. */
    graphAudit(opts: { project?: string; limit?: number } = {}) {
        const q: Record<string, string | undefined> = {};
        if (opts.project) q.project = opts.project;
        if (opts.limit !== undefined) q.limit = String(opts.limit);
        return this.call("graph.audit", params(q));
    }
    listMessages(q: Record<string, string | number | undefined> = {}) {
        return this.call("message.list", params(q));
    }
    getMessage(id: number) {
        return this.call("message.get", { id });
    }
    listTickets(q: Record<string, string | undefined> = {}) {
        return this.call("ticket.list", params(q));
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
        return this.call("ticket.get", { id, ...q });
    }
    listProjects() {
        return this.call("project.list");
    }
    /** #2089 — soft config reload, in band. `aiball reload` used to send
     *  SIGUSR2 to the pidfile, which on Windows terminates the daemon instead
     *  of reloading it. */
    reloadDaemon() {
        return this.call<{ reloaded: boolean; global_config: string; hot_window_sec: unknown }>("daemon.reload");
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
        return this.call<{
            name: string;
            display_name: string | null;
            description: string | null;
            created_at: string;
            created_by: string | null;
        }>("project.create", {
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
        return this.call<{ ticket_id: number; postponed_until: string }>("ticket.postpone", { id: ticket_id, until });
    }
    unsnoozeTicket(ticket_id: number) {
        return this.call<{ ticket_id: number; postponed_until: null }>("ticket.unsnooze", { id: ticket_id });
    }
    /**
     * Move a ticket (whole thread) to another project (#294). Reporter-or-
     * human only (enforced daemon-side via the x-aiball-consumer identity).
     */
    moveTicket(ticket_id: number, project: string) {
        return this.call("ticket.move", { id: ticket_id, project });
    }
    /** #2180 — a ticket's pending `child_of` children, one level, each with who
     *  attached it and when. A read. */
    pendingChildren(ticket_id: number) {
        return this.call<{
            ticket_id: number;
            children: Array<{
                ticket_id: number;
                project: string;
                title: string;
                reporter: string | null;
                attached_by: string | null;
                attached_at: string;
            }>;
        }>("ticket.pending_children", { id: ticket_id });
    }
    /** #2180 — approve exactly these children (human only). Pass the ids you
     *  listed: anything that is not, or no longer, a pending child comes back in
     *  `skipped` and is never approved. */
    approvePendingChildren(ticket_id: number, ticket_ids: number[]) {
        return this.call<{
            approved: number[];
            skipped: Array<{ ticket_id: number; reason: string }>;
        }>("ticket.approve_pending_children", { id: ticket_id, ticket_ids });
    }
    /** #2216/#2241 — set a ticket's level (human only). The response may carry a
     *  `warning` when the ticket's holder does not work on the new level. */
    setTicketLevel(ticket_id: number, level: "task" | "milestone" | "roadmap") {
        return this.call("message.edit", { id: ticket_id, level });
    }
    /**
     * #418: assign / claim a ticket. Pass `assignee` to PUSH it onto another
     * consumer (human/moderator only); omit it (or pass your own id) to CLAIM it
     * for yourself. A live assignment narrows the ticket out of OTHER consumers'
     * actionable pool until it expires (assign_window_sec), is released, or the
     * ticket closes — multi-agent anti-collision.
     */
    assignTicket(ticket_id: number, assignee?: string) {
        return this.call<{ ticket_id: number; assignee: string | null; claimant: string | null; assigned_by: string; is_claim: boolean }>(
            "ticket.assign",
            { id: ticket_id, ...(assignee ? { assignee } : {}) },
        );
    }
    /** #418: release a ticket's assignment / claim — back to the shared pool. */
    releaseTicket(ticket_id: number) {
        return this.call<{ ticket_id: number; released: boolean }>("ticket.release", { id: ticket_id });
    }
    /**
     * #749 Phase A — mark every unread ping the consumer has on `ticket_id`
     * (and its comments) as seen. Mirrors POST `/api/tickets/:id/mark-read`
     * (#B.191). Wraps the existing dwell-timer ack the web UI fires, so
     * the agent path stays symmetric : an MCP `ticket_get(X)` consumes the
     * pings for X just like the human opening the thread in the browser.
     * Optional `upToId` bounds the ack (don't flip pings for comments that
     * landed AFTER the consult).
     */
    markTicketRead(ticket_id: number, opts?: { upToId?: number }) {
        const body: { up_to_id?: number } = {};
        if (opts?.upToId) body.up_to_id = opts.upToId;
        return this.call<{ ticket_id: number; up_to_id?: number; updated: number }>("ticket.mark_read", { id: ticket_id, ...body });
    }
    /**
     * Create or change a typed relation (#275) from `ticket_id` → `target`.
     * Append-only: posting the same active kind is a server-side no-op;
     * `kind="ignored"` removes the edge (tombstone). Mirrors
     * POST /api/tickets/:id/relations. The daemon enforces self-relation,
     * kind validity, target existence, reporter-or-human permission, the
     * lineage cycle guard, and idempotency.
     */
    relate(ticket_id: number, target_ticket_id: number, kind: string, axis_kind?: string) {
        return this.call<{
            ticket_id: number;
            event_id: number | null;
            noop?: boolean;
            relations: unknown[];
        }>("ticket.relate", {
            id: ticket_id,
            target_ticket_id,
            kind,
            // #1468 — scopes an `ignored` tombstone to a single axis.
            ...(axis_kind ? { axis_kind } : {}),
        });
    }
    /**
     * Upstream coupling phase 2 — manual import. Fetch an external issue
     * (e.g. `gh#123` or `gh:owner/repo#123`) and create a coupled aiball
     * ticket from it. The daemon does the fetch (it holds the host-level
     * token) and applies labels→tags + the per-ticket coupling columns.
     */
    importUpstream(ref: string, project?: string) {
        return this.call<{
            ticket: { id: number; title: string | null; tags: unknown[] };
            external: { num: number; title: string; state: string; url: string; labels: string[] };
            provider: string;
        }>("ticket.import", {
            ref,
            ...(project ? { project } : {}),
        });
    }
    /**
     * Upstream coupling phase 2 — manual export. Create a new external issue
     * from an existing aiball ticket and couple the ticket to it. WRITES to
     * the remote (a new GitHub issue), so callers should confirm first. The
     * daemon holds the write-scoped token. `repo` overrides the project's
     * default binding; omit to use it.
     */
    exportUpstream(ticket_id: number, opts: { kind?: string; repo?: string; by_agent?: string } = {}) {
        return this.call<{
            ticket: { id: number; title: string | null; tags: unknown[] };
            external: { num: number; title: string; state: string; url: string; labels: string[] };
            provider: string;
        }>("ticket.export", {
            id: ticket_id,
            ...(opts.kind ? { kind: opts.kind } : {}),
            ...(opts.repo ? { repo: opts.repo } : {}),
            ...(opts.by_agent ? { by_agent: opts.by_agent } : {}),
        });
    }
    /**
     * Same endpoint with `detailed=1` — returns objects with counts
     * (ticket_count, open_count, pending_count, last_activity…) instead
     * of bare names. Used by poll() to surface per-project workload.
     */
    listProjectsDetailed(opts?: { landscape?: boolean; /** #2682 — only this project in the answer. */ project?: string | null }) {
        // #379: pass `landscape=1` to also get landscape_hash + landscape_last_activity
        // per project (the drained-strategy reset/dedup primitive). Off by default —
        // only the claude-loop timer asks for it, sidebar polls don't pay the O(N).
        const ls = { ...(opts?.landscape ? { landscape: true } : {}), ...(opts?.project ? { project: opts.project } : {}) };
        return this.call<Array<{
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
        }>>("project.list", { detailed: true, consumer_id: this.agentId, ...ls });
    }
    feedPath(project: string) {
        return this.call<{ path: string }>("project.feed_path", { project }).catch(() => {
            // Daemon down: compute locally
            if (!/^[a-zA-Z0-9_.-]+$/.test(project))
                throw new Error(`invalid project name: ${project}`);
            return { path: join(this.outboxDir, `${project}.jsonl`) };
        });
    }

    // ---- subscriptions ----------------------------------------------------

    subscribe(project: string, catchup = false, role?: "owner" | "follower") {
        return this.call("project.subscribe", { consumer_id: this.agentId, project, catchup, ...(role ? { role } : {}) });
    }
    unsubscribe(project: string) {
        return this.call("project.unsubscribe", { consumer_id: this.agentId, project });
    }
    mySubs() {
        return this.call("project.subscriptions", { consumer_id: this.agentId });
    }
    /** #1542 — the daemon's resolved config surface. Today used to read the
     *  `upstream` binding map (which projects have a coupling target) so the
     *  MCP can gate the import/export tools on it. */
    getConfig() {
        return this.call<{
            upstream?: Record<string, Array<{ kind: string; ref: string; default?: boolean }>>;
        }>("config.get");
    }
    /** #800 — project is OPTIONAL. Omitted/empty = cross-project FIFO.
     *  #798 — `since` is an ISO 8601 cutoff. Filters messages whose
     *  `created_at` is >= since. */
    unread(project: string | null | undefined, limit = 100, since?: string) {
        return this.call("unread.list", {
            consumer_id: this.agentId,
            ...(project ? { project } : {}),
            limit,
            ...(since ? { since } : {}),
        });
    }
    markMessageSeen(message_id: number) {
        return this.call("unread.mark_read", { consumer_id: this.agentId, message_id });
    }

    /** #786 — record that the loop just named this ticket in a backlog
     *  wake. Drives the per-consumer cooldown filter on `?backlog=1`. */
    recordBacklogWake(ticket_id: number) {
        return this.call("backlog.record_wake", { consumer_id: this.agentId, ticket_id });
    }
    /** #2255 — external signals still waiting for this agent. */
    listSignals() {
        return this.call("signal.list");
    }
    /** #2255 — the loop injected this signal: stop delivering it. */
    ackSignal(signal_id: number) {
        return this.call("signal.ack", { id: signal_id });
    }

    // ---- ticket subscriptions + pings ------------------------------------

    subscribeTicket(ticket_id: number) {
        return this.call("ticket.subscribe", { consumer_id: this.agentId, ticket_id });
    }
    unsubscribeTicket(ticket_id: number) {
        return this.call("ticket.unsubscribe", { consumer_id: this.agentId, ticket_id });
    }
    myTicketSubs() {
        return this.call("ticket.subscriptions", { consumer_id: this.agentId });
    }
    listPings(opts: { unreadOnly?: boolean; limit?: number } = {}) {
        return this.call("ping.list", {
            consumer_id: this.agentId,
            ...(opts.unreadOnly ? { unread: true } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        });
    }
    markPingsRead(opts: { upToId?: number; all?: boolean }) {
        return this.call("ping.mark_read", {
            consumer_id: this.agentId,
            ...(opts.upToId !== undefined ? { up_to_id: opts.upToId } : {}),
            ...(opts.all === true ? { all: true } : {}),
        });
    }
    pingsCount() {
        return this.call<{ unread: number }>("ping.count", { consumer_id: this.agentId });
    }

    /** #397: fetch a single consumer (incl. `micro_prompt`). Used by the wake
     *  builder to inject `{consumer_prompt}` into the relance prompt. */
    /** #2588 — every consumer, with `present` = its loop is connected now. */
    listConsumers() {
        return this.call<Array<{ consumer_id: string; kind: string; present: boolean | null }>>("consumer.list");
    }

    getConsumer(id: string) {
        return this.call<{ consumer_id: string; micro_prompt?: string | null; agent_type?: string | null }>("consumer.get", { consumer_id: id });
    }

    /** #1819: the facts for judging whether a human is around — elapsed
     *  times, no verdict. `project` scopes the human-message lookup. */
    presence(project?: string | null) {
        return this.call<{
            last_human_message_at?: string | null;
            last_human_message_age_sec?: number | null;
            loop_presence_word?: string | null;
            loop_human_flag?: boolean | null;
            loop_state_age_sec?: number | null;
        }>("consumer.presence", project ? { project } : {});
    }

    /** #1832: the project's standing instruction, shown at the head of every
     *  wake. Fetched per wake like the consumer's micro-prompt — the operator
     *  edits it precisely so the NEXT wake picks it up, so a cached value
     *  would defeat the point. */
    getProjectStandingPrompt(project: string) {
        return this.call<{ project: string; standing_prompt?: string | null; focus_line?: string }>("project.standing_prompt", { project });
    }

    /** #2910 — put a ticket in a milestone, move it, or take it out (null). */
    setTicketMilestone(ticket_id: number, milestone_id: number | null) {
        return this.call<{ ticket_id: number; milestone: { id: number; title: string; released: boolean } | null }>(
            "ticket.set_milestone",
            { id: ticket_id, milestone_id },
        );
    }

    /** #2910 — a project's milestones, oldest first, with state and progress. */
    listMilestones(project: string) {
        return this.call<{ project: string; milestones: { id: number; title: string; released: boolean; released_at: string | null; created_at: string; done: number; open: number }[] }>("project.milestones", { project });
    }

    /** #2770 — the project's critical ticket (holds back the most open tickets), or null. */
    getProjectCritical(project: string) {
        return this.call<{ project: string; critical: { id: number; title: string; holds: number; last_moved_at: string | null; quiet: string } | null }>("project.critical", { project });
    }

    /** #404: push a turn's token-usage delta onto a ticket (additive). Called
     *  best-effort by the Stop-hook's token-capture; failures are swallowed. */
    postTokenUsage(ticketId: number, u: { in: number; out: number; cacheW: number; cacheR: number }) {
        return this.call("ticket.add_token_usage", { id: ticketId, in: u.in, out: u.out, cache_w: u.cacheW, cache_r: u.cacheR });
    }

    /** #634 david `svzkpw` — push a turn's token-usage delta onto a PROJECT
     *  (no-marker fallback path in the Stop-hook). Additive ; best-effort. */
    postProjectTokenUsage(project: string, u: { in: number; out: number; cacheW: number; cacheR: number }) {
        return this.call("project.add_token_usage", { project, in: u.in, out: u.out, cache_w: u.cacheW, cache_r: u.cacheR });
    }

    /**
     * #B.177 B1: push the current claude-loop state for this consumer
     * (own-state only — the daemon refuses cross-consumer pushes).
     * Best-effort: failures are not surfaced to the caller, the timer
     * heartbeats again on the next tick.
     */
    /** #3340 — the clients attached to this agent's tmux loop: how many, how many with the controls. */
    pushClients(clients: number, interactive: number) {
        return this.call<{ consumer_id: string; clients: number; interactive: number }>("consumer.push_clients", { consumer_id: this.agentId, clients, interactive });
    }

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
        return this.call<{ consumer_id: string; state: string; human?: boolean; human_word?: string }>("consumer.push_state", { consumer_id: this.agentId, ...body });
    }

    /** #3030 — push this loop's bar as data (see `agent-bar.ts`), on change. */
    pushAgentBar(bar: AgentBar) {
        return this.call<{ consumer_id: string; changed: boolean }>("consumer.push_bar", { consumer_id: this.agentId, bar });
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
        onHello?: (payload: { consumer_id: string; unread: number; counters?: { open: number; actionable: number; backlog: number; events: number } | null }) => void;
        // #3133: the agent's counters, pushed by the daemon when a number changed.
        onCounters?: (payload: { open: number; actionable: number; backlog: number; events: number }) => void;
        // #442/#451: out-of-band control events (remote kill / raw-prompt
        // injection) on the same stream.
        onControl?: (payload: ControlEvent) => void;
        // #2255: external signals, replayed by the daemon on every (re)connect.
        onSignal?: (payload: { id: number; source: string; title: string; body: string | null; severity: "normal" | "panic"; repeat_count: number; expires_at: string }) => void;
        onError?: (err: Error) => void;
        /** #3321 — the loop's backlog rest, said to the daemon with the subscription. */
        backlogCooldownSec?: number;
    }): () => void {
        // #3068 — the loop's events come over the bus (`agent.<id>.events`), on a
        // connection of their own: it is the loop's liveness, open for as long
        // as the loop listens. Any end (the daemon closed it, a refusal) goes to
        // onError once; the caller reconnects, as it did for the event stream.
        type Ev = { event: string; data: unknown };
        let stopped = false;
        let failed = false;
        let conn: BusClient | null = null;
        const fail = (e: Error) => {
            if (stopped || failed) return;
            failed = true;
            conn?.close();
            handlers.onError?.(e);
        };
        const headers = this.identityHeaders();
        void (async () => {
            try {
                conn = await BusClient.connect(this.socketPath
                    ? { socket: this.socketPath, headers }
                    : { url: this.url, token: this.token ?? undefined, headers });
                if (stopped) { conn.close(); return; }
                void conn.closed().then((code) => fail(new Error(`the bus closed the event subscription (${code})`)));
                let subscription: string | null = null;
                const early: Ev[] = [];
                const dispatch = (ev: Ev) => {
                    if (ev.event === "ping") handlers.onPing(ev.data as Parameters<typeof handlers.onPing>[0]);
                    else if (ev.event === "control") handlers.onControl?.(ev.data as ControlEvent);
                    else if (ev.event === "signal") handlers.onSignal?.(ev.data as Parameters<NonNullable<typeof handlers.onSignal>>[0]);
                    else if (ev.event === "counters") handlers.onCounters?.(ev.data as Parameters<NonNullable<typeof handlers.onCounters>>[0]);
                };
                conn.onNotification((method, params) => {
                    const p = params as { subscription?: string; data?: Ev } | null;
                    if (method !== "bus.event" || !p?.data) return;
                    if (subscription === null) { early.push(p.data); return; }
                    if (p.subscription === subscription) dispatch(p.data);
                });
                const r = await conn.call<{ id: string; value: Parameters<NonNullable<typeof handlers.onHello>>[0] }>("bus.subscribe", {
                    subject: `agent.${this.agentId}.events`,
                    ...(handlers.backlogCooldownSec !== undefined ? { backlog_cooldown_sec: handlers.backlogCooldownSec } : {}),
                });
                subscription = r.id;
                handlers.onHello?.(r.value);
                for (const ev of early.splice(0)) dispatch(ev);
            } catch (e) {
                fail(e instanceof Error ? e : new Error(String(e)));
            }
        })();
        return () => {
            stopped = true;
            conn?.close();
        };
    }
    /** #800 — project optional. Omitted = cross-project consumer-scoped count. */
    unreadCount(project: string | null | undefined) {
        return this.call<{ count: number }>("unread.count", { consumer_id: this.agentId, ...(project ? { project } : {}) });
    }
    /** #2198 — `project`, `summary` (no bodies) and `limit` are applied by the
     *  daemon, so nothing crosses the socket only to be thrown away. */
    myPendingTickets(opts: PendingListOpts = {}) {
        return this.call("message.list", this.pendingQuery("ticket_created", opts));
    }
    /**
     * Pending comments authored by this agent. Symmetric to
     * myPendingTickets() — both surface in poll() so the agent sees
     * its own submissions blocked in moderation regardless of kind
     * (per #B.69).
     */
    myPendingComments(opts: PendingListOpts = {}) {
        return this.call("message.list", this.pendingQuery("comment_added", opts));
    }
    private pendingQuery(kind: "ticket_created" | "comment_added", opts: PendingListOpts): Record<string, unknown> {
        return {
            kind,
            status: "pending",
            by_agent: this.agentId,
            ...(opts.project ? { project: opts.project } : {}),
            ...(opts.summary ? { summary: true } : {}),
            ...(opts.limit ? { limit: opts.limit } : {}),
            // #2339 — poll lists the pending tickets it counts: a ticket closed
            // while it waited in moderation is not waiting any more.
            ...(kind === "ticket_created" ? { open: true } : {}),
        };
    }
    /**
     * First + last non-rejected ticket in scope — used by the slim
     * `poll()` (per #B.68). Cross-project by default; pass project to
     * restrict. include_snoozed widens the scope.
     */
    bookends(opts: { project?: string; includeSnoozed?: boolean } = {}) {
        return this.call<{ first: unknown; last: unknown }>("ticket.bookends", {
            ...(opts.project ? { project: opts.project } : {}),
            ...(opts.includeSnoozed ? { include_snoozed: true } : {}),
        });
    }
    myPendingCount() {
        return this.call<{ count: number }>("message.pending_count", { by_agent: this.agentId });
    }
    /**
     * #697 F5 — pending plan / resolution decisions on tickets THIS agent
     * reports, waiting for accept / reject. Distinct from `myPendingTickets`,
     * which surfaces drafts of THIS agent's still in moderation (waiting on a
     * moderator). `myArbitrage` is the inverse : work waiting on THIS agent.
     */
    /**
     * #699 — rename a project across every table that stores its name.
     * Cascades via the daemon's transactional helper (db/projects.ts:
     * renameProject). 404 / 409 / 400 surface as `http()` errors.
     */
    renameProject(oldName: string, newName: string) {
        return this.call<{
            ok: boolean;
            old_name: string;
            new_name: string;
            tickets: number;
            tickets_from_project: number;
            subscriptions: number;
            rules: number;
            work_filters: number;
            automation_rules: number;
            consumers: number;
            config_overrides: number;
            project_token_usage: number;
        }>("project.rename", { name: oldName, new_name: newName });
    }
    /**
     * #699 — delete a project. Surface for the new CLI command after the
     * UI delete button was removed (david : "pour supprimer il faut
     * appeler le aiball cli").
     */
    deleteProject(name: string) {
        return this.call<{
            ok: boolean;
            project: string;
            deleted_messages: number;
        }>("project.delete", { name });
    }
    /** #1164 S1 — plans of MINE that were accepted and I haven't acted on
     *  since ("what should I go execute now"). */
    plansToExecute() {
        return this.call("decision.plans_to_execute");
    }
    myArbitrage() {
        return this.call<{
            decisions: Array<{
                comment_id: number;
                comment_hashid: string | null;
                ticket_id: number;
                ticket_title: string;
                ticket_project: string;
                decision_kind: DecisionKind;
                proposed_by: string | null;
                created_at: string;
                summary_until: string | null;
                actionable?: boolean;
                superseded?: boolean;
                superseded_by?: string | null;
            }>;
        }>("decision.mine");
    }

    // ---- admin / decisions ------------------------------------------------

    approve(id: number) {
        return this.call("message.approve", { id });
    }
    reject(id: number) {
        return this.call("message.reject", { id });
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
        return this.call("message.edit", { id, ...fields });
    }
    /**
     * Overwrite the tag set on a message (ticket or comment). Pass
     * tag NAMES — the daemon resolves to ids via getTagByName.
     * Unknown names bubble up as 400.
     */
    setMessageTags(id: number, tag_names: string[]) {
        // #3036 — who tags is the caller; the daemon takes it from the identity sent.
        return this.call("message.set_tags", { id, tag_ids: tag_names });
    }
    note(id: number, note: string | null) {
        return this.call("message.note", { id, note });
    }
    /** #2697 — moderation rules are automation rules: trigger `message_posted`,
     *  action `decision`. That is the only table moderation reads. */
    async listRules() {
        const rules = await this.call("automation.rules", { trigger: "message_posted" }) as Array<{
            actions?: Array<{ kind?: string }>;
        }>;
        return rules.filter((r) => (r.actions ?? []).some((a) => a.kind === "decision"));
    }
    addRule(rule: {
        decision: "auto" | "review";
        match_project?: string;
        match_kind?: string;
        match_by_agent?: string;
        note?: string;
    }) {
        const { decision, ...match } = rule;
        return this.call("automation.create_rule", {
            triggers: ["message_posted"],
            action: { kind: "decision", decision },
            ...match,
        });
    }
    deleteRule(id: number) {
        return this.call("automation.delete_rule", { id });
    }
    toggleRule(id: number, enabled: boolean) {
        return this.call("automation.update_rule", { id, enabled });
    }
    /**
     * Bulk mark-read by project. Pass either upToId or all=true.
     * Mirrors the bash `aiball mark-read` semantics.
     */
    markReadProject(opts: {
        project?: string;
        upToId?: number;
        all?: boolean;
        allProjects?: boolean;
        del?: boolean;
        consumer?: string;
    }) {
        const body: Record<string, unknown> = {
            // #1185 — an operator (local CLI) can target another consumer's
            // backlog; defaults to this client's own identity.
            consumer_id: opts.consumer ?? this.agentId,
        };
        if (opts.project) body.project = opts.project;
        if (opts.allProjects === true) body.all_projects = true;
        else if (opts.all === true) body.all = true;
        else if (opts.upToId !== undefined) body.up_to_id = opts.upToId;
        if (opts.del === true) body.delete = true;
        return this.call("unread.mark_read", body);
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
        return this.call("consumer.upsert", input);
    }
    /** #2180 — patch a consumer record. The capability fields (`agent_type`,
     *  `can_claim`) are refused unless the caller is a human (`--human`). */
    patchConsumer(id: string, patch: { agent_type?: "coder" | "cto"; can_claim?: boolean }) {
        return this.call("consumer.update", { consumer_id: id, ...patch });
    }

    /** #3066 3c — run the prepared command in this agent's session on the daemon's host. */
    sessionHost(o: { agent: string; argv: string[]; cwd: string; size?: { rows: number; cols: number }; env?: Record<string, string> }) {
        return this.call<{ agent: string; attach: { socket: string | null }; control: string; pid: number }>("session.host", o);
    }
    /** #3166 — the sessions on the daemon's host, as `session.list` gives them. */
    sessionList() {
        return this.call<Array<{ agent: string | null; name: string | null; running?: boolean; attach?: { socket: string | null } }>>("session.list", {});
    }
    /** #3066 — stop this agent's session on the daemon's host (the loop's own `rm`). */
    sessionStop(agent: string) {
        // #3158 — waits for the host to be gone: `claude-loop rm` starts the loop again right after.
        return this.call<{ agent: string; exit_code: number | null }>("session.stop", { agent, wait: true });
    }
    health() {
        return this.http<{ ok: boolean; ts: string; version?: string }>("GET", "/api/health");
    }

    /** Public auth probe: is web login set up, is an install token open, and
     *  does the daemon accept the bearer this client sends (`me`). */
    authStatus() {
        return this.http<{
            ready: boolean;
            install_available: boolean;
            install_expires_at: string | null;
            me: { consumer_id: string; kind: string } | null;
        }>("GET", "/api/auth/status");
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

    /** #2629 — declared step delays against when the agent came back. */
    stepTiming(project: string | null, sinceDays: number | null) {
        return this.call<{ project: string | null; since: string | null; buckets: Array<{ bucket: string; steps: number; avg_declared: number; early: number; on_time: number; late: number; pending: number }>; credits?: Array<{ consumer_id: string; project: string; balance: number; earned: number; spent: number; refunded: number }> }>(
            "step.timing", { ...(project ? { project } : {}), ...(sinceDays ? { since_days: sinceDays } : {}) });
    }

    /** #2586 — running / installed / latest release, as the daemon last checked. */
    version() {
        return this.http<VersionInfo>("GET", "/api/version");
    }

    /** #2586 — ask the daemon to check GitHub now (answers its cache within a minute). */
    checkVersion() {
        return this.http<VersionInfo>("POST", "/api/version/check", {});
    }
}

/**
 * #855 — decide whether a thrown error from a daemon HTTP call is
 * retriable transparently (= daemon mid-restart / transient). Retriable :
 *   - `ECONNREFUSED` / `ENOENT` (UDS path absent during a daemon restart
 *      window) — the request never reached the daemon, so a retry is safe
 *      even for POSTs (no double-write risk).
 *   - `ECONNRESET` / `socket hang up` thrown BEFORE the daemon flushed
 *      any response bytes — same reasoning : nothing landed yet.
 *   - HTTP 502 / 503 / 504 — daemon up but transient (reverse proxy
 *     between us and daemon could be mid-restart on managed deploys).
 * NOT retriable :
 *   - 4xx — deterministic client error, retrying will fail identically.
 *   - 5xx ≠ 502/503/504 — server logic error, retrying won't help.
 *   - Timeout once the request was sent — a POST may have side-effected
 *     the server even if we never saw the response ; replaying would
 *     double-write.
 */
/** #855 retry policy. Exported for unit tests. */
export const RETRY_BACKOFF_MS = [300, 1000, 3000];

/** #855 — retry-with-backoff wrapper. Attempt up to (1 + RETRY_BACKOFF_MS.length)
 *  times with the configured delays. Only retriable errors trigger a retry ;
 *  everything else propagates immediately. Exported for unit tests. */
export async function withRetry<T>(
    fn: () => Promise<T>,
    delays: readonly number[] = RETRY_BACKOFF_MS,
): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (!isRetriableHttpError(e)) throw e;
            if (attempt === delays.length) break;
            await new Promise<void>((res) => setTimeout(res, delays[attempt]));
        }
    }
    throw lastErr;
}

export function isRetriableHttpError(e: unknown): boolean {
    if (e === null || typeof e !== "object") return false;
    const err = e as { code?: string; status?: number; message?: string };
    if (err.code === "ECONNREFUSED" || err.code === "ENOENT") return true;
    if (typeof err.status === "number" && (err.status === 502 || err.status === 503 || err.status === 504)) {
        return true;
    }
    // node http "socket hang up" lands with code=ECONNRESET on some node
    // versions and no code on others — match by message too.
    if (err.code === "ECONNRESET") return true;
    if (typeof err.message === "string" && /socket hang up/i.test(err.message)) return true;
    // #2462 — `write EPIPE`: the peer closed the connection while the request was
    // still being written. The daemon never received a complete request, so it
    // ran nothing and a replay cannot double-write — the same footing as the
    // ECONNRESET above, which differs only in when the client noticed. Observed
    // as a `ticket_claim` failing three times with that bare text and no retry.
    if (err.code === "EPIPE") return true;
    return false;
}

/**
 * #2462 — a transport error (EPIPE, ECONNRESET, ENOENT…) arrives from Node as
 * bare text: `write EPIPE` said nothing of which call, on which socket, so the
 * one report of it could not be traced. Keep the code (the retry policy reads
 * it), put the request and the transport in front of the message.
 */
export function transportError(e: Error & { code?: string }, method: string, path: string, via: string): Error {
    const wrapped = new Error(`${method} ${path} via ${via}: ${e.message}`) as Error & { code?: string; cause?: unknown };
    if (e.code) wrapped.code = e.code;
    wrapped.cause = e;
    return wrapped;
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

/** A filter's fields as a method's params: an unset or empty one is left out, as a query string did. */
function params(q: Record<string, string | number | undefined>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") out[k] = v;
    return out;
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

/**
 * The agent's standing — its multi-agent role and whether it may claim —
 * resolved like its id: the environment first (claude-loop exports
 * AIBALL_ROLE / AIBALL_NO_CLAIM), else the folder's `.aiball.yaml`, with the
 * rule claude-loop applies: a `crew` agent never claims.
 *
 * Reading only the environment made a plain `claude` in a crew agent's folder
 * (its MCP started from `.mcp.json`, outside claude-loop) state no role at
 * all: the MCP subscribed it as an owner and it could claim, whatever the
 * yaml said. `cwd` null = the environment alone (a client built for another
 * agent than the folder's).
 */
export function resolveConsumerStanding(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string | null = resolveUserCwd(),
): { role: "lead" | "crew" | null; noClaim: boolean } {
    let yaml: { role: "lead" | "crew" | null; no_claim: boolean } | null = null;
    if (cwd !== null) {
        try { yaml = loadConfig(cwd).consumer; } catch { /* no readable config: env only */ }
    }
    const envRole = env.AIBALL_ROLE;
    const role = envRole === "lead" || envRole === "crew" ? envRole
        : envRole ? null // set but unknown: stated, not guessed
        : yaml?.role ?? null;
    const noClaim = env.AIBALL_NO_CLAIM !== undefined
        ? env.AIBALL_NO_CLAIM === "1"
        : (yaml?.no_claim ?? false) || role === "crew";
    return { role, noClaim };
}

/**
 * The machine secret, when a client of this machine has neither a socket nor a
 * token: the daemon then treats it as a local caller, as over the socket. Only
 * ever sent to a loopback address — a secret that proves "same user on this
 * machine" means nothing, and must not travel, anywhere else.
 */
export function localMachineSecret(socketPath: string | null, url: string, home: string): string | null {
    if (socketPath) return null;
    let host: string;
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return null; }
    if (host !== "localhost" && !isLoopback(host)) return null;
    return readMachineSecret(join(home, "machine-secret"));
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
