/**
 * Auth helpers (#B.94). Wraps:
 *   - scrypt-based password hash + verify.
 *   - bearer-token middleware that runs in front of every /api/* route.
 *
 * Password hashing uses Node's built-in `crypto.scrypt` — zero deps,
 * no native module to compile. Hash format is
 *   `scrypt$<N>$<r>$<p>$<salt-hex>$<derived-hex>`
 * so we can bump parameters later without breaking existing rows.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
    anyHumanCredentials,
    ensureConsumer,
    getTokenAndTouch,
    setTokenLastSeenIp,
    updateTokenLabel,
    isHuman,
    touchLastSeen,
    type Token,
} from "./db.js";
import { getConsumer, updateConsumer } from "./db/consumers.js";
import { keyProjects, keyScopes } from "./db/signal-keys.js";
import { refuse } from "./api/_helpers.js";
import { ERROR_CODES, type ErrorCode } from "./domain.js";

// The options overload of `crypto.scrypt` doesn't survive `promisify`'s
// type inference, so we keep the callback form behind a typed helper.
function scryptAsync(
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number },
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keylen, options, (err, derived) => {
            if (err) reject(err);
            else resolve(derived);
        });
    });
}

// scrypt cost parameters. N=16384 / r=8 / p=1 is the Node default
// recommendation and gives ~100ms hash on modern hardware. Safe for
// interactive logins; increase later if needed without breaking old
// rows because we embed the parameters in the hash string.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
    })) as Buffer;
    return [
        "scrypt",
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString("hex"),
        derived.toString("hex"),
    ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    if (!stored || !stored.startsWith("scrypt$")) return false;
    const parts = stored.split("$");
    if (parts.length !== 6) return false;
    const [, nStr, rStr, pStr, saltHex, derivedHex] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(derivedHex, "hex");
    const got = (await scryptAsync(password, salt, expected.length, { N, r, p })) as Buffer;
    // Constant-time compare to avoid timing leaks.
    if (got.length !== expected.length) return false;
    return timingSafeEqual(got, expected);
}

// =====================================================================
// Bearer-token middleware
// =====================================================================

/**
 * Attach the authenticated consumer to the request. Mounted on every
 * /api/* route except the public bypass list (see PUBLIC_PATHS).
 *
 * Order:
 *   1. Read Authorization: Bearer <token> (or X-Aiball-Token fallback).
 *   2. Look up the token. Reject if missing / expired / install-kind
 *      (install tokens only grant /setup access).
 *   3. Resolve token.consumer_id, attach to req.
 *
 * The legacy `X-Aiball-Consumer` header is honored as an override
 * ONLY when the authenticated principal is a human moderator — the
 * web UI uses this to "view as <agent>" without re-authenticating.
 * Agents cannot override their identity.
 */
export interface AuthenticatedRequest extends Request {
    consumer_id?: string;
    token_kind?: Token["kind"];
    /** #508 phase A2 — set true when a node-token request carries
     *  `x-aiball-no-claim: 1` for this consumer (declared no-claim by the
     *  relaying proxy). Effective in addition to `consumers.can_claim=false`. */
    no_claim_hint?: boolean;
    /** #2255 — set for a `signal` key: the label it was minted with, which IS
     *  the source of the signals it posts. */
    signal_source?: string;
    /** #2526 — for a signal key: what it may do, and where it may create tickets. */
    signal_scopes?: string[];
    signal_projects?: string[];
}

// Paths are relative to the router mount (`api = Router()` mounted at
// `/api` by the daemon), so we check `/health` not `/api/health`.
const PUBLIC_PATHS = new Set<string>([
    "/health",
    "/auth/setup",
    "/auth/login",
    "/auth/status",
    // #2074 — a node asking to be paired has no credential yet; that is what it
    // is asking for. This route records an INTENT and can mint nothing, so the
    // worst an unauthenticated caller achieves is a row a human won't approve.
    "/nodes/enroll",
]);

/**
 * #2074 — the pairing POLL, which carries a request id and so cannot be an
 * exact match. Public for the same reason as `/nodes/enroll`, and safe for a
 * narrower one: it serves a token ONLY for a request a human already approved,
 * exactly once. Knowing an id lets you watch a request, never create or
 * approve one.
 *
 * A prefix rather than a regex over the whole path: `startsWith` here can only
 * ever widen to routes we deliberately put under this one segment.
 */
function isPublicPath(path: string): boolean {
    if (PUBLIC_PATHS.has(path)) return true;
    return path.startsWith("/nodes/enroll/");
}

export function readBearerToken(req: Request): string | null {
    const q = req.query?.token;
    return bearerFrom((name) => req.header(name), typeof q === "string" ? q : null);
}

/**
 * The credential a caller sent: `Authorization: Bearer`, else `x-aiball-token`,
 * else the `?token=` query value. Shared by HTTP and the bus's opening request.
 */
export function bearerFrom(header: (name: string) => string | undefined, query: string | null): string | null {
    const auth = header("authorization");
    if (auth && /^bearer\s+/i.test(auth)) {
        return auth.replace(/^bearer\s+/i, "").trim();
    }
    const fallback = header("x-aiball-token");
    if (typeof fallback === "string" && fallback) return fallback.trim();
    // A browser's WebSocket cannot set headers, so the bus's opening request
    // carries the bearer as `?token=`; other browser fetches send the
    // Authorization header and never hit this path. Tokens-in-URL has known
    // downsides (logs, Referer, history) — that's why this is the LAST
    // fallback, only honored when no header was provided.
    if (query && query.trim()) return query.trim();
    return null;
}

/**
 * #3063 — who a caller is, decided once from what its request carries. HTTP
 * runs it on every request (`bearerAuth`); the bus runs it once, on the
 * request that opens the connection, and keeps the result for the whole
 * connection. One function, so the two can never disagree on an identity.
 */
export interface AuthInput {
    /** The local socket (same-user trust) or TCP. */
    transport: "uds" | "tcp";
    header(name: string): string | undefined;
    /** The credential sent (`bearerFrom`), or null. */
    token: string | null;
    /** The TCP peer address; null on the local socket. */
    ip: string | null;
}

/** The caller, as `authenticate` settled it. */
export interface CallerContext {
    consumer_id?: string;
    token_kind: Token["kind"];
    transport: "uds" | "tcp";
    /** The credential the identity rests on: null on the local socket. */
    token: string | null;
    no_claim_hint?: boolean;
    signal_source?: string;
    signal_scopes?: string[];
    signal_projects?: string[];
    /**
     * #2652 — protocol features the client declares it knows (`x-aiball-client`),
     * and the platform it runs on (`x-aiball-platform`): what the client is,
     * not who. Read with the identity.
     */
    client_features?: string[];
    platform?: string | null;
}


export type AuthOutcome =
    | { ok: true; ctx: CallerContext }
    | { ok: false; status: number; error: string; code: ErrorCode; hint?: string };

export function authenticate(input: AuthInput): AuthOutcome {
    // Unix-socket local-trust bypass (per #B.94 follow-up). The daemon
    // tags every UDS-borne socket with __aiballUds at connection time;
    // those requests inherit OS-level same-uid trust (chmod 600 on the
    // socket file) so no bearer is needed. Identity is read from the
    // X-Aiball-Consumer header — defaults to "human" if omitted, since
    // a same-uid caller is the local owner of this aiball instance.
    if (input.transport === "uds") {
        const override = input.header("x-aiball-consumer");
        const explicit = typeof override === "string" && override.trim() ? override.trim() : null;
        // #386: an anonymous local call (no X-Aiball-Consumer header) still
        // RESOLVES to the local owner ("human") for authorization, but must NOT
        // refresh that consumer's last_seen — otherwise the literal "human"
        // consumer keeps "resurfacing" as active on the consumers page even when
        // the human only ever uses a named identity. Only an EXPLICIT identity
        // (header present) touches last_seen.
        const ctx: CallerContext = { consumer_id: explicit ?? "human", token_kind: "agent", transport: "uds", token: null };
        if (explicit) touchLastSeen(ctx.consumer_id!, "uds"); // #B.177 / #386 / #422 (local same-uid)
        readHints(input, ctx);
        return { ok: true, ctx };
    }
    const token = input.token;
    if (!token) {
        return {
            ok: false,
            status: 401,
            error: "authentication required",
            code: ERROR_CODES.AUTH_REQUIRED,
            hint: anyHumanCredentials()
                ? "log in at /login or pass Authorization: Bearer <agent token>"
                : "no humans yet — run `aiball auth init` in a terminal, then open the printed setup URL",
        };
    }
    const row = getTokenAndTouch(token);
    if (!row) {
        return { ok: false, status: 401, error: "invalid or expired token", code: ERROR_CODES.TOKEN_INVALID };
    }
    if (row.kind === "install") {
        return { ok: false, status: 403, error: "install tokens cannot access /api/* — use POST /api/auth/setup first", code: ERROR_CODES.FORBIDDEN };
    }
    // #2255 — a signal key is bound to no consumer and its label is the source
    // of what it posts. Which door it may open is the transport's check.
    if (row.kind === "signal") {
        return {
            ok: true,
            ctx: {
                token_kind: "signal",
                transport: "tcp",
                token,
                signal_source: row.label ?? "unnamed",
                // #2526 — a key minted before scopes existed holds `signals` only.
                signal_scopes: keyScopes(row),
                signal_projects: keyProjects(row),
            },
        };
    }
    // #394 volet C: a "node" token authenticates a trusted proxy NODE, not a
    // consumer. Like a reverse-proxy whitelisted to set X-Forwarded-For, it may
    // ASSERT a relayed identity via x-aiball-consumer — which we HONOR here (and
    // auto-create), unlike a regular agent token where the token wins and the
    // header is ignored. Without the header, default to the node's local owner
    // ("human"), mirroring the UDS local-trust default. Node tokens are service
    // tokens with no bound consumer.
    if (row.kind === "node") {
        const override = input.header("x-aiball-consumer");
        const explicit = typeof override === "string" && override.trim() ? override.trim() : null;
        const ctx: CallerContext = { consumer_id: explicit ?? "human", token_kind: "node", transport: "tcp", token };
        // Auto-register a relayed agent we haven't seen yet (the loop on B has
        // no token of its own — the node vouches for it). Never touches humans.
        if (explicit && !isHuman(ctx.consumer_id!)) ensureConsumer(ctx.consumer_id!);
        touchLastSeen(ctx.consumer_id!, "node", input.ip); // #422: proxy-relayed → remote
        setTokenLastSeenIp(token, input.ip); // #424: stamp the node's address for the Nodes panel
        // #463 — proxy node advertises its current label on every request.
        // Sync the token's label when it changed (renaming the node in its
        // own config is reflected in the Nodes panel without re-minting).
        // Skip when header absent (older proxy, direct curl, …) or empty.
        // Trim + cap length defensively — the label hits the UI directly.
        const advertised = input.header("x-aiball-node-label");
        if (typeof advertised === "string") {
            const labelRaw = advertised.trim().slice(0, 200);
            if (labelRaw && labelRaw !== row.label) updateTokenLabel(token, labelRaw);
        }
        readHints(input, ctx);
        return { ok: true, ctx };
    }
    if (!row.consumer_id) {
        return { ok: false, status: 403, error: "token is not bound to a consumer", code: ERROR_CODES.FORBIDDEN };
    }
    const ctx: CallerContext = { consumer_id: row.consumer_id, token_kind: row.kind, transport: "tcp", token };
    // Human-only impersonation via the legacy X-Aiball-Consumer header.
    const override = input.header("x-aiball-consumer");
    if (typeof override === "string" && override && override !== row.consumer_id) {
        if (isHuman(row.consumer_id)) {
            ctx.consumer_id = override;
        }
        // Non-humans: silently ignore the override.
    }
    touchLastSeen(ctx.consumer_id!, "tcp", input.ip); // #B.177 / #422 (direct bearer over TCP)
    readHints(input, ctx);
    return { ok: true, ctx };
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    if (isPublicPath(req.path)) {
        next();
        return;
    }
    const uds = (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    const out = authenticate({
        transport: uds ? "uds" : "tcp",
        header: (name) => req.header(name),
        token: uds ? null : readBearerToken(req),
        ip: uds ? null : clientIp(req),
    });
    if (!out.ok) {
        if (out.status === 401) res.set("www-authenticate", "Bearer");
        res.status(out.status).json({ error: out.error, code: out.code, ...(out.hint ? { hint: out.hint } : {}) });
        return;
    }
    const ctx = out.ctx;
    // #2255 / #2526 — a signal key opens exactly one door per scope.
    if (ctx.token_kind === "signal") {
        const door = req.method === "POST" && req.path === "/signals" ? "signals"
            : req.method === "POST" && req.path === "/tickets" ? "tickets:create"
            : null;
        if (!door) {
            refuse(res, 403, `an API key can only POST /api/signals (scope signals) or POST /api/tickets (scope tickets:create)`);
            return;
        }
        if (!ctx.signal_scopes!.includes(door)) {
            refuse(res, 403, `this key lacks the scope ${door}`, ERROR_CODES.KEY_SCOPE_MISSING);
            return;
        }
    }
    const ar = req as AuthenticatedRequest;
    ar.consumer_id = ctx.consumer_id;
    ar.token_kind = ctx.token_kind;
    if (ctx.no_claim_hint) ar.no_claim_hint = true;
    if (ctx.token_kind === "signal") {
        ar.signal_source = ctx.signal_source;
        ar.signal_scopes = ctx.signal_scopes;
        ar.signal_projects = ctx.signal_projects;
    }
    next();
}

function readHints(input: AuthInput, ctx: CallerContext): void {
    readNoClaimHint(input, ctx);
    readRoleHint(input, ctx);
    readClient(input, ctx);
}

function readClient(input: AuthInput, ctx: CallerContext): void {
    const features = String(input.header("x-aiball-client") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    if (features.length) ctx.client_features = features;
    const platform = input.header("x-aiball-platform");
    if (typeof platform === "string" && platform) ctx.platform = platform;
}

/**
 * #508 phase A2 — read the `x-aiball-no-claim: 1` header REGARDLESS of token
 * kind (node-relayed OR direct agent token). claude-loop exports
 * `AIBALL_NO_CLAIM=1` from the project `.aiball.yaml consumer.no_claim` and
 * the client lib injects the header on every request. Trust the agent's own
 * declaration (no privilege escalation — it gates the agent OUT of the
 * claim pool, never IN). Stashed on `AuthenticatedRequest.no_claim_hint`
 * for the claimable lens in `api/tickets.ts`.
 *
 * Called at the END of the auth chain — after `consumer_id`/`token_kind` are
 * known. Re-applied also on the UDS local-trust path (humans driving a loop
 * over UDS with AIBALL_NO_CLAIM set in their env).
 */
/** #1183 — the `x-aiball-no-claim: 1` header (claude-loop/MCP exports it from the
 *  project `.aiball.yaml consumer.no_claim`) is the CANONICAL no-claim declaration.
 *  Persist it to `consumers.can_claim=false` so the notification fan-out gate
 *  (#752-B, `notifications.ts`) honours it — the header alone is per-request +
 *  lens-only, so a `no_claim` owner would otherwise still get the full default-scope
 *  firehose. The project's own config drives it, with NO global `proxy.project_yaml`
 *  pointer (supersedes the #775 config-push : the header already carries it from the
 *  project dir). Trust the agent's own declaration (it gates the agent OUT of the
 *  claim pool, never IN). Diff-guarded: write only on the true→false flip, so there's
 *  no DB write per request. Also stashed on `ar.no_claim_hint` for the claimable lens. */
function readNoClaimHint(input: AuthInput, ar: CallerContext): void {
    const v = input.header("x-aiball-no-claim");
    if (typeof v === "string" && (v === "1" || v.toLowerCase() === "true")) {
        ar.no_claim_hint = true;
        if (ar.consumer_id) {
            const c = getConsumer(ar.consumer_id);
            if (c && c.can_claim) {
                updateConsumer(ar.consumer_id, { can_claim: false });
            }
        }
    }
}

/** #1435 slice 5 — persist the agent's multi-agent role from the `x-aiball-role`
 *  header so it shows in the UI. Unlike no_claim (one-way, capability), role is a
 *  descriptor: update-on-change in BOTH directions (an agent relaunched with a
 *  different role updates it) — but only when the header is present (absence never
 *  clears it). Only `lead`/`crew` are accepted; anything else is ignored. Role is
 *  self-declared (how the loop launched), NOT a gated capability, so it's set here
 *  and deliberately kept out of the #1477 PATCH capability guard. */
function readRoleHint(input: AuthInput, ar: CallerContext): void {
    const v = input.header("x-aiball-role");
    if (v !== "lead" && v !== "crew") return;
    if (!ar.consumer_id) return;
    const c = getConsumer(ar.consumer_id);
    if (c && c.role !== v) {
        updateConsumer(ar.consumer_id, { role: v });
    }
}

/** #422: the TCP peer address (B's IP for a proxy node; the client's for direct).
 *  `socket.remoteAddress` is the raw peer — no trust-proxy config needed. */
function clientIp(req: Request): string | null {
    return req.socket?.remoteAddress ?? null;
}

/**
 * Helper used outside middlewares (web socket handshake, batch jobs)
 * to resolve a token without express. Returns the consumer_id when
 * the token is auth/agent and valid; null otherwise.
 */
export function resolveTokenToConsumer(token: string): string | null {
    const row = getTokenAndTouch(token);
    if (!row) return null;
    if (row.kind === "install") return null;
    return row.consumer_id ?? null;
}
