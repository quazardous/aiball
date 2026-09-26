/**
 * #3039 — the net under every refusal: a JSON answer with an HTTP error status
 * and an `error` but no `code` gets the generic code of its status. A refusal
 * written before the codes, or one nobody has made precise yet, still carries
 * a code a client can branch on; a precise code, set where the refusal is
 * written, always wins.
 */
import type { NextFunction, Request, Response } from "express";
import { errorCodeForStatus } from "../domain.js";

export function errorCodeDefaults(_req: Request, res: Response, next: NextFunction): void {
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
        if (res.statusCode >= 400 && body !== null && typeof body === "object" && !Array.isArray(body)) {
            const b = body as Record<string, unknown>;
            if (typeof b.error === "string" && b.code === undefined) {
                return json({ ...b, code: errorCodeForStatus(res.statusCode) });
            }
        }
        return json(body);
    };
    next();
}
