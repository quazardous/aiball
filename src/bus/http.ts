/**
 * #3063 — an HTTP route that serves a bus method, while its clients move over
 * to the bus. The route only says where the parameters sit in the request;
 * who may call, the validation and the code are the method's, so the route
 * and the bus cannot answer differently. Each is removed once the last client
 * calling it has moved.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { callerContextOf } from "../auth.js";
import { ERROR_CODES } from "../domain.js";
import { refuse } from "../api/_helpers.js";
import { accessRefusal, callerOf, getMethod, Refusal, type AnyMethod } from "./methods.js";
import "./register.js";

/** Where a route's parameters sit in its request. */
export type ParamsFrom = (req: Request) => unknown;

/**
 * Path parameters, then the query, then the body: what most routes take. A
 * function declaration: route modules call `serveMethod` while this module may
 * still be loading (they import each other), and only a declaration exists then.
 */
export function fromRequest(req: Request): unknown {
    return { ...(req.body && typeof req.body === "object" ? req.body : {}), ...req.query, ...req.params };
}

/** Run `m` for an HTTP request: the same checks, the same answer as on the bus. */
export async function runOverHttp(m: AnyMethod, req: Request, params: unknown): Promise<unknown> {
    const ctx = callerContextOf(req);
    if (!ctx) throw new Refusal(401, "authentication required", ERROR_CODES.AUTH_REQUIRED);
    const caller = callerOf(ctx);
    const denied = accessRefusal(m, caller);
    if (denied) throw denied;
    const parsed = m.params.safeParse(params ?? {});
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Refusal(400, first ? `${first.path.join(".") || "params"}: ${first.message}` : "invalid params", ERROR_CODES.BAD_REQUEST, {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
    }
    return m.run(caller, parsed.data);
}


/** The methods routes serve, for the test that checks each exists. */
export function servedMethods(): Set<string> {
    // Kept on the function itself: it exists before this module has run.
    const holder = servedMethods as unknown as { names?: Set<string> };
    return (holder.names ??= new Set<string>());
}

/**
 * An Express handler serving the method `name`. By name, looked up when a
 * request comes: a route module and the method module may import each other,
 * and neither needs the other while it loads.
 */
export function serveMethod(
    name: string,
    from: ParamsFrom = fromRequest,
    opts: {
        status?: number;
        /** How the result goes out, when HTTP carries part of it outside the body. */
        respond?: (res: Response, result: unknown) => void;
    } = {},
): RequestHandler {
    servedMethods().add(name);
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const m = getMethod(name);
            if (!m) throw new Error(`no bus method ${name}`);
            const result = await runOverHttp(m, req, from(req));
            res.status(opts.status ?? 200);
            if (opts.respond) opts.respond(res, result);
            else res.json(result === undefined ? null : result);
        } catch (e) {
            if (e instanceof Refusal) {
                refuse(res, e.status, e.message, e.code, e.details);
                return;
            }
            next(e);
        }
    };
}
