/**
 * Shared HTTP helpers of the api/* routers (#B.213 phase 1): refusals and who
 * is asking. Kept tiny — anything domain-specific belongs in the router that
 * owns it, not here. Decorating rows with their tags and votes is a read's
 * business: src/queries/decorate.ts.
 */
import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../auth.js";
import { ERROR_CODES, errorCodeForStatus, isErrorCode, type ErrorCode } from "../domain.js";

/**
 * #3039 — every refusal is `{ error, code, details? }`: the sentence for a
 * human, the code (`ERROR_CODES`) for a client. Without a code, the helpers
 * put the generic one of their status; name a precise one where a client may
 * react on it.
 */
export function refuse(res: Response, status: number, msg: string, code?: ErrorCode, details?: Record<string, unknown>): Response {
    return res.status(status).json({ error: msg, code: code ?? errorCodeForStatus(status), ...(details ? { details } : {}) });
}

/**
 * #3039 — a caught error as a refusal: its own code when it carries one, else
 * the generic code of `status`.
 */
export function refuseError(res: Response, status: number, err: unknown): Response {
    const code = (err as { code?: unknown } | null)?.code;
    return refuse(res, status, err instanceof Error ? err.message : String(err), isErrorCode(code) ? code : undefined);
}

/**
 * #3036 — the author of a write is the authenticated caller (`consumerOf`),
 * never a name in the body: identity belongs to the transport. A body may
 * still carry the author field (older clients do); equal to the caller it is
 * accepted, anything else is refused (403 `AUTHOR_MISMATCH`). Returns the
 * author, or null once the refusal is sent.
 *
 * Over TCP the caller is bound to its token; on the local socket it is the
 * `x-aiball-consumer` header, declared by the caller — consistency there, not
 * a security boundary (docs/SECURITY.md).
 */
export function authorFor(req: Request, res: Response, given: unknown, field = "by_agent"): string | null {
    const caller = consumerOf(req);
    if (given === undefined || given === null || given === "" || given === caller) return caller;
    refuse(
        res,
        403,
        `${field} "${String(given)}" is not the caller (${caller}): the author of a write is who is authenticated — leave ${field} out`,
        ERROR_CODES.AUTHOR_MISMATCH,
    );
    return null;
}

export function badRequest(res: Response, msg: string, code?: ErrorCode): Response {
    return refuse(res, 400, msg, code);
}

export function forbidden(res: Response, msg: string, code?: ErrorCode): Response {
    return refuse(res, 403, msg, code);
}

export function notFound(res: Response, msg = "not found", code?: ErrorCode): Response {
    return refuse(res, 404, msg, code);
}

export function conflict(res: Response, msg: string, code?: ErrorCode): Response {
    return refuse(res, 409, msg, code);
}

/**
 * Resolve the consumer id for a request. Prefers the auth-middleware's
 * `req.consumer_id` (set by bearerAuth from a valid token), falling back
 * to the `x-aiball-consumer` header for routes reached before/without
 * auth, and finally to `AIBALL_HUMAN` env (defense in depth — should
 * not be hit in practice).
 */
export function consumerOf(req: Request): string {
    const ar = req as AuthenticatedRequest;
    if (ar.consumer_id) return ar.consumer_id;
    const headerVal = req.header("x-aiball-consumer");
    if (typeof headerVal === "string" && headerVal.trim()) return headerVal.trim();
    return process.env.AIBALL_HUMAN ?? "human";
}

/** #442: the request's auth tier (`agent` = UDS/direct bearer, `node` = proxy
 *  node token), set by bearerAuth. Undefined on routes reached without auth. */
export function tokenKindOf(req: Request): string | undefined {
    return (req as AuthenticatedRequest).token_kind;
}
