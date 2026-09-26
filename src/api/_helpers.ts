/**
 * Shared HTTP / payload-shaping helpers used across the api/* sub-routers
 * (#B.213 phase 1). Kept tiny — anything domain-specific belongs in the
 * sub-router that owns it, not here.
 */
import type { Request, Response } from "express";
import { listMessageTags, tagsForMessages, type Tag } from "../db.js";
import { parseMeta } from "../questions.js";
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
 * Decorate one or many messages with their tags so callers can render
 * them without an N+1 round-trip. Uses one bulk SELECT regardless of
 * the number of messages.
 */
export function withTags<T extends { id: number }>(rows: T[]): (T & { tags: Tag[] })[] {
    const map = tagsForMessages(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: map.get(r.id) ?? [] }));
}

export function withTagsOne<T extends { id: number }>(row: T): T & { tags: Tag[] } {
    return { ...row, tags: listMessageTags(row.id) };
}

/**
 * #518 (MVP option A) — vote summary lisible par le front. `up` / `down` =
 * compteurs agrégés depuis meta.votes ; `mine` = la valeur du viewer
 * courant (`1 | -1 | null`). Décoré sur les messages du thread + sur
 * la réponse du POST /vote pour que l'UI se mette à jour atomiquement.
 */
export interface VoteSummary {
    up: number;
    down: number;
    mine: 1 | -1 | null;
}

export function summarizeVotes(meta: string | null, viewer: string): VoteSummary {
    const votes = parseMeta(meta).votes ?? {};
    let up = 0;
    let down = 0;
    let mine: 1 | -1 | null = null;
    for (const [voter, v] of Object.entries(votes)) {
        if (v === 1) up += 1;
        else if (v === -1) down += 1;
        if (voter === viewer) mine = v;
    }
    return { up, down, mine };
}

/** Décore un tableau de messages avec leur votes_summary pour le viewer
 *  courant. Renvoie le row tel quel + un champ `votes_summary` ajouté. */
export function withVotes<T extends { id: number; kind: string; meta?: string | null }>(
    rows: T[],
    viewer: string,
): (T & { votes_summary?: VoteSummary })[] {
    return rows.map((r) => {
        if (r.kind !== "comment_added") return r;
        return { ...r, votes_summary: summarizeVotes(r.meta ?? null, viewer) };
    });
}

export function withVotesOne<T extends { id: number; kind: string; meta?: string | null }>(
    row: T,
    viewer: string,
): T & { votes_summary?: VoteSummary } {
    if (row.kind !== "comment_added") return row;
    return { ...row, votes_summary: summarizeVotes(row.meta ?? null, viewer) };
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
