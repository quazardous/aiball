/**
 * #3252 — a call the daemon refused, the same shape on every client: the CLI
 * and the MCP server (`AiballClient`), the bus client, the web. `code` is
 * aiball's code (docs/API-ERRORS.md), what a client branches on; `status` the
 * HTTP status it matches; the message is for a human; `details` what the
 * refusal names. Pure: the web imports it too.
 */
import { errorCodeForStatus } from "./domain.js";

export class ApiError extends Error {
    constructor(
        readonly code: string,
        readonly status: number,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
    }
}

/**
 * A refused HTTP answer as an ApiError. Its body is a refusal
 * (`{ error, code, details }`) or, from something in front of the daemon, any
 * text: then the status's generic code. The message keeps the body as sent.
 */
export function apiErrorOf(status: number, text: string, context: string): ApiError {
    type RefusalBody = { code?: unknown; details?: unknown };
    let body: RefusalBody | null = null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") body = parsed as RefusalBody;
    } catch { /* not a refusal body */ }
    const code = typeof body?.code === "string" ? body.code : errorCodeForStatus(status);
    const details = body?.details && typeof body.details === "object" ? body.details as Record<string, unknown> : undefined;
    return new ApiError(code, status, `${context} → ${status}: ${text}`, details);
}
