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
    isHuman,
    touchLastSeen,
    type Token,
} from "./db.js";

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
}

// Paths are relative to the router mount (`api = Router()` mounted at
// `/api` by the daemon), so we check `/health` not `/api/health`.
const PUBLIC_PATHS = new Set<string>([
    "/health",
    "/auth/setup",
    "/auth/login",
    "/auth/status",
]);

function readBearerToken(req: Request): string | null {
    const auth = req.header("authorization");
    if (auth && /^bearer\s+/i.test(auth)) {
        return auth.replace(/^bearer\s+/i, "").trim();
    }
    const fallback = req.header("x-aiball-token");
    if (typeof fallback === "string" && fallback) return fallback.trim();
    return null;
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    if (PUBLIC_PATHS.has(req.path)) {
        next();
        return;
    }
    // Unix-socket local-trust bypass (per #B.94 follow-up). The daemon
    // tags every UDS-borne socket with __aiballUds at connection time;
    // those requests inherit OS-level same-uid trust (chmod 600 on the
    // socket file) so no bearer is needed. Identity is read from the
    // X-Aiball-Consumer header — defaults to "human" if omitted, since
    // a same-uid caller is the local owner of this aiball instance.
    if ((req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true) {
        const override = req.header("x-aiball-consumer");
        const explicit = typeof override === "string" && override.trim() ? override.trim() : null;
        // #386: an anonymous local call (no X-Aiball-Consumer header) still
        // RESOLVES to the local owner ("human") for authorization, but must NOT
        // refresh that consumer's last_seen — otherwise the literal "human"
        // consumer keeps "resurfacing" as active on the consumers page even when
        // the human only ever uses a named identity. Only an EXPLICIT identity
        // (header present) touches last_seen.
        const cid = explicit ?? "human";
        const ar = req as AuthenticatedRequest;
        ar.consumer_id = cid;
        ar.token_kind = "agent";
        if (explicit) touchLastSeen(cid, "uds"); // #B.177 / #386 / #422 (local same-uid)
        next();
        return;
    }
    const token = readBearerToken(req);
    if (!token) {
        res.status(401).set("www-authenticate", "Bearer").json({
            error: "authentication required",
            hint: anyHumanCredentials()
                ? "log in at /login or pass Authorization: Bearer <agent token>"
                : "no humans yet — run `aiball auth init` in a terminal, then open the printed setup URL",
        });
        return;
    }
    const row = getTokenAndTouch(token);
    if (!row) {
        res.status(401).set("www-authenticate", "Bearer").json({
            error: "invalid or expired token",
        });
        return;
    }
    if (row.kind === "install") {
        res.status(403).json({
            error: "install tokens cannot access /api/* — use POST /api/auth/setup first",
        });
        return;
    }
    // #394 volet C: a "node" token authenticates a trusted proxy NODE, not a
    // consumer. Like a reverse-proxy whitelisted to set X-Forwarded-For, it may
    // ASSERT a relayed identity via x-aiball-consumer — which we HONOR here (and
    // auto-create), unlike a regular agent token where the token wins and the
    // header is ignored. Without the header, default to the node's local owner
    // ("human"), mirroring the UDS local-trust default. Node tokens are service
    // tokens with no bound consumer.
    if (row.kind === "node") {
        const override = req.header("x-aiball-consumer");
        const explicit = typeof override === "string" && override.trim() ? override.trim() : null;
        const cid = explicit ?? "human";
        const ar = req as AuthenticatedRequest;
        ar.consumer_id = cid;
        ar.token_kind = "node";
        // Auto-register a relayed agent we haven't seen yet (the loop on B has
        // no token of its own — the node vouches for it). Never touches humans.
        if (explicit && !isHuman(cid)) ensureConsumer(cid);
        touchLastSeen(cid, "node", clientIp(req)); // #422: proxy-relayed → remote
        next();
        return;
    }
    if (!row.consumer_id) {
        res.status(403).json({ error: "token is not bound to a consumer" });
        return;
    }
    const ar = req as AuthenticatedRequest;
    ar.consumer_id = row.consumer_id;
    ar.token_kind = row.kind;

    // Human-only impersonation via the legacy X-Aiball-Consumer header.
    const override = req.header("x-aiball-consumer");
    if (typeof override === "string" && override && override !== row.consumer_id) {
        if (isHuman(row.consumer_id)) {
            ar.consumer_id = override;
        }
        // Non-humans: silently ignore the override.
    }
    touchLastSeen(ar.consumer_id, "tcp", clientIp(req)); // #B.177 / #422 (direct bearer over TCP)
    next();
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
