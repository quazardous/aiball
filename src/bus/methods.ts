/**
 * #3063 — the core as a table of methods. A method is a function of the
 * caller and its parameters, and declares in one place who may call it and
 * what it takes; it sees no HTTP request. The bus calls it (`callMethod`
 * checks who may, then the parameters, then runs it).
 */
import type { z } from "zod";
import type { CallerContext } from "../auth.js";
import type { BusSession } from "./subscriptions.js";
import { isHuman } from "../db.js";
import { ERROR_CODES, errorCodeForStatus, isErrorCode, type ErrorCode } from "../domain.js";

/**
 * Who the caller is:
 * - `human`: a human consumer;
 * - `agent`: an agent;
 * - `key`: an API key, which also needs the method's `scope`.
 */
export type CallerKind = "human" | "agent" | "key";

/** The caller of a method: the identity settled once, its kind, and how it came. */
export interface Caller extends CallerContext {
    kind: CallerKind;
    /**
     * Relayed by a proxy node, whose token vouches for whoever it names: the
     * weak point (docs/SECURITY.md). A method that must not be reached that
     * way says `relayed: false`.
     */
    relayed: boolean;
    /** The consumer, for the kinds that have one (human, agent). */
    consumer_id?: string;
    /** On the bus: the connection, where subscriptions live. Absent over HTTP. */
    session?: BusSession;
}

/** `kind` is fixed with the identity: a connection computes it once. */
export function callerOf(ctx: CallerContext): Caller {
    const kind: CallerKind = ctx.token_kind === "signal" ? "key"
        : ctx.consumer_id && isHuman(ctx.consumer_id) ? "human"
        : "agent";
    return { ...ctx, kind, relayed: ctx.token_kind === "node" };
}

/** The caller's consumer id; a method open to humans and agents only always has one. */
export function consumerIdOf(caller: Caller): string {
    if (!caller.consumer_id) throw new Refusal(403, "this caller is not a consumer", ERROR_CODES.FORBIDDEN);
    return caller.consumer_id;
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
    /** false: refused to a caller relayed by a proxy node. Default true. */
    relayed?: boolean;
    /** The refusal a caller outside `who` gets, when a precise one exists. */
    denied?: { message: string; code: ErrorCode };
    params: S;
    run(caller: Caller, params: z.infer<S>): R | Promise<R>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMethod = MethodSpec<z.ZodType, any>;

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
    // Before the kind: a node may name a human, and must not reach what nodes may not.
    if (caller.relayed && m.relayed === false) {
        return new Refusal(403, `${m.name} is not open through a proxy node`, ERROR_CODES.FORBIDDEN);
    }
    if (!m.who.includes(caller.kind)) {
        if (m.denied) return new Refusal(403, m.denied.message, m.denied.code);
        return new Refusal(403, `${m.name} is not open to ${caller.kind === "key" ? "an API key" : `a ${caller.kind}`}`, ERROR_CODES.FORBIDDEN);
    }
    if (caller.kind === "key" && !(caller.signal_scopes ?? []).includes(m.scope!)) {
        return new Refusal(403, `this key lacks the scope ${m.scope}`, ERROR_CODES.KEY_SCOPE_MISSING);
    }
    return null;
}

/**
 * #3242 — a call as the bus makes it, for a caller settled elsewhere: who may
 * call, then the parameters, then the method. Throws the `Refusal`, as the
 * method would; an unknown method is a 404, invalid parameters a 400 naming
 * the first one.
 */
export async function callMethod(caller: Caller, name: string, params: unknown): Promise<unknown> {
    const m = getMethod(name);
    if (!m) throw new Refusal(404, `no method ${name}`, ERROR_CODES.NOT_FOUND);
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

/**
 * #3036 — the author of a write is the caller: a params field naming someone
 * else is refused (403 `AUTHOR_MISMATCH`), as over HTTP.
 */
export function authorOf(caller: Caller, given: unknown, field = "by_agent"): string {
    const me = consumerIdOf(caller);
    if (given === undefined || given === null || given === "" || given === me) return me;
    throw new Refusal(
        403,
        `${field} "${String(given)}" is not the caller (${me}): the author of a write is who is authenticated — leave ${field} out`,
        ERROR_CODES.AUTHOR_MISMATCH,
    );
}

/** A caught error as a refusal: its own code when it carries one, else the generic code of `status`. */
export function refusalFrom(status: number, err: unknown): Refusal {
    const code = (err as { code?: unknown } | null)?.code;
    return new Refusal(status, err instanceof Error ? err.message : String(err), isErrorCode(code) ? code : undefined);
}

/** Test hook: forget a method defined by a test. */
export function undefineMethodForTests(name: string): void {
    registry.delete(name);
}
