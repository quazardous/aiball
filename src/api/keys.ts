/**
 * #3248 — the API key behind a key-only door (POST /api/signals, POST
 * /api/tickets). Over TCP the auth middleware has checked it and its scope for
 * the door. On the Unix socket the middleware trusts a caller without a token,
 * so the door reads the key itself: required there too, valid, and holding the
 * door's scope.
 */
import type { Request } from "express";
import { readBearerToken, type AuthenticatedRequest } from "../auth.js";
import { getTokenAndTouch } from "../db/tokens.js";
import { keyProjects, keyScopes } from "../db/signal-keys.js";
import { ERROR_CODES, type ErrorCode } from "../domain.js";

export type KeyDoor = "signals" | "tickets:create";
export type KeyGrant = { source: string; projects: string[] };
export type KeyRefusal = { status: 401 | 403; error: string; code: ErrorCode };

/**
 * The key's source (its label) and projects, or why the door stays shut.
 * `notAKey`: the refusal for a caller that holds no API key. `keyless`: a
 * socket caller with no key at all — told a key is required (401), or, where
 * such a caller has another way in (an agent files with POST /api/messages),
 * given `notAKey` (403).
 */
export function keyFor(req: Request, door: KeyDoor, notAKey: string, keyless: "required" | "not-a-key" = "required"): KeyGrant | KeyRefusal {
    const ar = req as AuthenticatedRequest;
    if (ar.token_kind === "signal" && ar.signal_source) return { source: ar.signal_source, projects: ar.signal_projects ?? [] };
    const onSocket = (req.socket as unknown as { __aiballUds?: boolean }).__aiballUds === true;
    if (onSocket) {
        const bearer = readBearerToken(req);
        if (!bearer) {
            return keyless === "required"
                ? { status: 401, error: "an API key is required (Authorization: Bearer <key>), on the socket too", code: ERROR_CODES.AUTH_REQUIRED }
                : { status: 403, error: notAKey, code: ERROR_CODES.FORBIDDEN };
        }
        const row = getTokenAndTouch(bearer);
        if (!row) return { status: 401, error: "invalid or expired API key", code: ERROR_CODES.TOKEN_INVALID };
        if (row.kind === "signal") {
            return keyScopes(row).includes(door)
                ? { source: row.label ?? "unnamed", projects: keyProjects(row) }
                : { status: 403, error: `this key lacks the scope ${door}`, code: ERROR_CODES.KEY_SCOPE_MISSING };
        }
    }
    return { status: 403, error: notAKey, code: ERROR_CODES.FORBIDDEN };
}
