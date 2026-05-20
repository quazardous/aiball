/**
 * Shared HTTP / payload-shaping helpers used across the api/* sub-routers
 * (#B.213 phase 1). Kept tiny — anything domain-specific belongs in the
 * sub-router that owns it, not here.
 */
import type { Request, Response } from "express";
import { listMessageTags, tagsForMessages, type Tag } from "../db.js";
import type { AuthenticatedRequest } from "../auth.js";

export function badRequest(res: Response, msg: string): Response {
    return res.status(400).json({ error: msg });
}

export function notFound(res: Response, msg = "not found"): Response {
    return res.status(404).json({ error: msg });
}

export function conflict(res: Response, msg: string): Response {
    return res.status(409).json({ error: msg });
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
