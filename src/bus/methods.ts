/**
 * #3063 — the core as a table of methods. A method is a function of the
 * caller and its parameters, and declares in one place who may call it and
 * what it takes; it sees no HTTP request. The bus calls it directly; while
 * clients move over, an HTTP route may call the same function.
 */
import type { z } from "zod";
import type { CallerContext } from "../auth.js";
import { isHuman } from "../db.js";
import { ERROR_CODES, errorCodeForStatus, type ErrorCode } from "../domain.js";

/**
 * The kinds of caller a method may admit:
 * - `human`: a human consumer, on the local socket or with its own token;
 * - `agent`: an agent, on the local socket or with its own token;
 * - `node`: anyone relayed by a proxy node, whose token is the weak point
 *   (docs/SECURITY.md);
 * - `key`: an API key, which also needs the method's `scope`.
 */
export type CallerKind = "human" | "agent" | "node" | "key";

/** The caller of a method: the identity settled once, and its kind. */
export interface Caller extends CallerContext {
    kind: CallerKind;
}

/** `kind` is fixed with the identity: a connection computes it once. */
export function callerOf(ctx: CallerContext): Caller {
    const kind: CallerKind = ctx.token_kind === "signal" ? "key"
        : ctx.token_kind === "node" ? "node"
        : ctx.consumer_id && isHuman(ctx.consumer_id) ? "human"
        : "agent";
    return { ...ctx, kind };
}

/** A method's refusal: the same `{ error, code }` an HTTP route answers. */
export class Refusal extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly code: ErrorCode = errorCodeForStatus(status),
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
    }
}

export interface MethodSpec<S extends z.ZodType, R> {
    /** Dotted, noun first: `ticket.reply`, `inbox.turn`. */
    name: string;
    /** Required, and never empty: a method nobody may call is a mistake. */
    who: readonly CallerKind[];
    /** With `who` holding `key`: the scope a key needs. */
    scope?: string;
    params: S;
    run(caller: Caller, params: z.infer<S>): R | Promise<R>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMethod = MethodSpec<z.ZodType, any>;

const registry = new Map<string, AnyMethod>();

export function defineMethod<S extends z.ZodType, R>(spec: MethodSpec<S, R>): MethodSpec<S, R> {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(spec.name)) {
        throw new Error(`bus method "${spec.name}": a name is dotted lowercase, noun first (ticket.reply)`);
    }
    if (registry.has(spec.name)) throw new Error(`bus method "${spec.name}" is defined twice`);
    if (!Array.isArray(spec.who) || spec.who.length === 0) {
        throw new Error(`bus method "${spec.name}" declares no caller: say who may call it`);
    }
    if (spec.who.includes("key") && !spec.scope) {
        throw new Error(`bus method "${spec.name}" admits API keys without naming the scope they need`);
    }
    registry.set(spec.name, spec as AnyMethod);
    return spec;
}

export function methodNames(): string[] {
    return [...registry.keys()].sort();
}

export function getMethod(name: string): AnyMethod | undefined {
    return registry.get(name);
}

/** Why `caller` may not call `m`, or null when it may. */
export function accessRefusal(m: AnyMethod, caller: Caller): Refusal | null {
    if (!m.who.includes(caller.kind)) {
        return new Refusal(403, `${m.name} is not open to a ${caller.kind === "key" ? "API key" : caller.kind}`, ERROR_CODES.FORBIDDEN);
    }
    if (caller.kind === "key" && !(caller.signal_scopes ?? []).includes(m.scope!)) {
        return new Refusal(403, `this key lacks the scope ${m.scope}`, ERROR_CODES.KEY_SCOPE_MISSING);
    }
    return null;
}

/** Test hook: forget a method defined by a test. */
export function undefineMethodForTests(name: string): void {
    registry.delete(name);
}
