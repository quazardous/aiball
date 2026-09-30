/**
 * #3063 — JSON-RPC 2.0 on top of the method table: one frame in, at most one
 * frame out. A batch runs its calls in order and answers them in one frame.
 */
import { RPC_ERRORS, type RpcError, type RpcId, type RpcResponse } from "../bus-protocol.js";
import { ERROR_CODES } from "../domain.js";
import { accessRefusal, getMethod, Refusal, type Caller } from "./methods.js";
import { beginCall, paramsShape, rowsOf } from "../request-stats.js";

/** Past this many calls, a batch is refused whole. */
export const MAX_BATCH = 100;

function fail(id: RpcId, error: RpcError): RpcResponse {
    return { jsonrpc: "2.0", id, error };
}

function refusalError(r: Refusal): RpcError {
    return { code: r.status, message: r.message, data: { code: r.code, status: r.status, ...(r.details ? { details: r.details } : {}) } };
}

const isId = (v: unknown): v is RpcId => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** One call. Null for a notification, which is run but never answered. */
export async function runOne(caller: Caller, msg: unknown): Promise<RpcResponse | null> {
    const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    if (!req || typeof req !== "object" || Array.isArray(req) || req.jsonrpc !== "2.0"
        || typeof req.method !== "string" || ("id" in req && !isId(req.id))) {
        return fail(isId(req?.id) ? req!.id as RpcId : null, {
            code: RPC_ERRORS.INVALID_REQUEST,
            message: "not a JSON-RPC 2.0 request",
            data: { code: ERROR_CODES.BAD_REQUEST, status: 400 },
        });
    }
    const notification = !("id" in req);
    const id = notification ? null : req.id as RpcId;
    const answer = (r: RpcResponse) => (notification ? null : r);

    const m = getMethod(req.method);
    if (!m) {
        return answer(fail(id, {
            code: RPC_ERRORS.METHOD_NOT_FOUND,
            message: `no method ${req.method}`,
            data: { code: ERROR_CODES.NOT_FOUND, status: 404 },
        }));
    }
    const denied = accessRefusal(m, caller);
    if (denied) return answer(fail(id, refusalError(denied)));

    const parsed = m.params.safeParse(req.params ?? {});
    if (!parsed.success) {
        return answer(fail(id, {
            code: RPC_ERRORS.INVALID_PARAMS,
            message: `invalid params for ${m.name}`,
            data: {
                code: ERROR_CODES.BAD_REQUEST,
                status: 400,
                details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
            },
        }));
    }
    // #3243 — every method call counted and timed with the HTTP routes, named in a stall.
    // #3405 — with what it was asked for, and how much it answers: which client asks what.
    const end = beginCall(`BUS ${m.name}`, { consumer: caller.consumer_id ?? null, agent: caller.machine ?? caller.transport ?? null, query: paramsShape(req.params), shaped: true });
    let rows: number | null | undefined;
    try {
        const result = await m.run(caller, parsed.data);
        rows = rowsOf(result);
        return answer({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (e) {
        if (e instanceof Refusal) return answer(fail(id, refusalError(e)));
        console.error(`[bus] ${m.name} failed:`, e);
        return answer(fail(id, {
            code: RPC_ERRORS.INTERNAL_ERROR,
            message: "internal error",
            data: { code: ERROR_CODES.INTERNAL, status: 500 },
        }));
    } finally {
        sizedBy.set(req, end({ rows }));
    }
}

/** #3405 — per call, what takes the size of its answer once the frame is serialised. */
const sizedBy = new WeakMap<object, (bytes: number) => void>();

/** One frame: a call or a batch. Null when nothing is to be answered. */
export async function handleFrame(caller: Caller, text: string): Promise<string | null> {
    let msg: unknown;
    try {
        msg = JSON.parse(text);
    } catch {
        return JSON.stringify(fail(null, {
            code: RPC_ERRORS.PARSE_ERROR,
            message: "not JSON",
            data: { code: ERROR_CODES.BAD_REQUEST, status: 400 },
        }));
    }
    if (!Array.isArray(msg)) {
        const r = await runOne(caller, msg);
        const text = r ? JSON.stringify(r) : null;
        // The size of a single call's answer; a batch's is not split between its calls.
        if (text && msg && typeof msg === "object") sizedBy.get(msg)?.(text.length);
        return text;
    }
    if (msg.length === 0 || msg.length > MAX_BATCH) {
        return JSON.stringify(fail(null, {
            code: RPC_ERRORS.INVALID_REQUEST,
            message: msg.length === 0 ? "an empty batch" : `a batch holds at most ${MAX_BATCH} calls`,
            data: { code: ERROR_CODES.BAD_REQUEST, status: 400 },
        }));
    }
    const out: RpcResponse[] = [];
    // In order: a client that writes then reads in one batch reads its write.
    for (const one of msg) {
        const r = await runOne(caller, one);
        if (r) out.push(r);
    }
    return out.length ? JSON.stringify(out) : null;
}
