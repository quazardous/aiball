/**
 * #3242 — a bus call as a client holding this token makes it, answered the way
 * the tests read the HTTP routes they used to go through: `{ status, json }`,
 * the result with 200, or a refusal's status with `{ error, code, details? }`.
 * The token is authenticated as a TCP client's is, so its kind (agent, human,
 * node, signal key) and what it may do are the real ones; the call then goes
 * through `callMethod`, the bus's own checks. Import it after the test has set
 * its AIBALL_HOME, as the rest of what touches the database.
 */
import { authenticate } from "../auth.js";
import { callerOf, callMethod, Refusal, type Caller } from "../bus/methods.js";
import "../bus/register.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Reply<T = any> { status: number; json: T }

/** The caller a TCP client with this bearer token is. Throws when the token is refused. */
export function callerOfToken(token: string): Caller {
    const out = authenticate({
        transport: "tcp",
        token,
        ip: "127.0.0.1",
        header: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
    });
    if (!out.ok) throw new Refusal(out.status, out.error, out.code);
    return callerOf(out.ctx);
}

/** Call `method` with `params` as the holder of `token`. */
export async function asToken<T = unknown>(token: string, method: string, params: Record<string, unknown> = {}): Promise<Reply<T>> {
    try {
        const result = await callMethod(callerOfToken(token), method, params);
        return { status: 200, json: (result === undefined ? null : result) as T };
    } catch (e) {
        if (e instanceof Refusal) {
            return { status: e.status, json: { error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) } as T };
        }
        throw e;
    }
}
