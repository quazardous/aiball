/**
 * Shared HTTP helpers of the api/* routers (#B.213 phase 1): refusals and who
 * is asking. Kept tiny — anything domain-specific belongs in the router that
 * owns it, not here. Decorating rows with their tags and votes is a read's
 * business: src/queries/decorate.ts.
 */
import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../auth.js";
import { errorCodeForStatus, type ErrorCode } from "../domain.js";

/**
 * #3039 — every refusal is `{ error, code, details? }`: the sentence for a
 * human, the code (`ERROR_CODES`) for a client. Without a code, the helpers
 * put the generic one of their status; name a precise one where a client may
 * react on it.
 */
export function refuse(res: Response, status: number, msg: string, code?: ErrorCode, details?: Record<string, unknown>): Response {
    return res.status(status).json({ error: msg, code: code ?? errorCodeForStatus(status), ...(details ? { details } : {}) });
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

