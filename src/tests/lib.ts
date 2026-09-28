/**
 * #3241 — the helpers tests kept copying: waiting for a condition, expecting a
 * refusal, a bus caller. One place, typed, so a change of the `Caller` shape
 * shows in the tests instead of hiding behind `as never`.
 */
import assert from "node:assert/strict";
import type { Caller, CallerKind } from "../bus/methods.js";

/** Pause `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Poll `ok` every `stepMs` until it holds; fail with `what` after `ms`. */
export async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 5000, stepMs = 25): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await ok())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await sleep(stepMs);
    }
}

/** A refusal as the bus throws it (`Refusal`) or a client reports it. */
export interface Refused { status: number; code?: string; message: string; details?: unknown }

/** Run `f` (sync or async), or await a call, and return what it threw; fail if it did not. */
export async function refused(f: (() => unknown) | Promise<unknown>): Promise<Refused> {
    try {
        await (typeof f === "function" ? f() : f);
    } catch (e) {
        return e as Refused;
    }
    return assert.fail("expected a refusal, got an answer");
}

/**
 * A caller of a bus method, as a connection would settle it: an agent on the
 * local socket by default (`kind: "human"` for a moderator); `tcp` for a
 * remote one, `relayed` for one a proxy node vouches for.
 */
export function testCaller(consumer_id: string, opts: { kind?: CallerKind; transport?: "uds" | "tcp"; relayed?: boolean } = {}): Caller {
    const kind = opts.kind ?? "agent";
    return {
        consumer_id,
        kind,
        transport: opts.transport ?? "uds",
        relayed: opts.relayed ?? false,
        token: null,
        token_kind: opts.relayed ? "node" : kind === "human" ? "auth" : "agent",
    };
}
