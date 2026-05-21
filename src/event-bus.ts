/**
 * In-process event bus for daemon-side event push (#B.148 phase A).
 *
 * The daemon is single-process, so a stdlib EventEmitter is enough —
 * no cross-process IPC needed. Subscribers (SSE handlers, future
 * websocket handlers) listen on event names; emitters (DB write paths
 * like `insertPing`) fire whenever the underlying state changes.
 *
 * Naming convention:
 *   - `ping:<recipient>` — a new ping was inserted for this consumer.
 *     Payload: `{ ticket_id?, comment_id?, comment_hashid?, intent? }`.
 *     For a comment ping, `ticket_id` is the parent ticket and
 *     `comment_hashid` is the public-facing ref (`#<hashid>`) —
 *     `comment_id` is the numeric `_messages.id` and is kept for
 *     backward-compat only; consumers should prefer the hashid when
 *     surfacing the ref to humans/agents. `intent` is the parent
 *     ticket's intent (panic / request / question / fyi) — lets
 *     downstream consumers (claude-loop wake phrase) scale the
 *     directiveness of the prompt to match the ticket's urgency.
 *
 * Keep this layer dumb: just a typed emitter. SSE filtering, batching,
 * keepalives all live in the consumer (api.ts). New event kinds get
 * added here as their emit-point lands.
 */
import { EventEmitter } from "node:events";
import type { Intent } from "./domain.js";
import type { Message } from "./db.js";

export interface PingEvent {
    ticket_id?: number;
    comment_id?: number;
    comment_hashid?: string;
    intent?: Intent;
}

const bus = new EventEmitter();
// SSE handlers (one per long-lived consumer connection) accumulate
// fast; bump the default ceiling so node doesn't warn.
bus.setMaxListeners(0);

export function emitPing(recipient: string, payload: PingEvent): void {
    bus.emit(`ping:${recipient}`, payload);
}

export function onPing(
    recipient: string,
    handler: (payload: PingEvent) => void,
): () => void {
    const key = `ping:${recipient}`;
    bus.on(key, handler);
    return () => bus.off(key, handler);
}

/**
 * #321: backend lifecycle bus. Every ticket lifecycle mutation (a message
 * landing, a decision, a move…) emits a typed `LifecycleEvent` here AFTER the
 * DB write; subscribers (WS broadcast, ping fan-out, and — #322 — the rules /
 * attribution engine) react via `onLifecycle`. Single-process EventEmitter →
 * synchronous + ordered; emit exactly once per mutation (no double-fire).
 *
 * Phase 1 (#321) is ADDITIVE: events fire alongside the existing inline
 * fanOutPings / broadcast calls (zero behaviour change). Phase 2 moves those
 * side-effects into `onLifecycle` handlers.
 */
export type LifecycleOp = "created" | "decided" | "edited" | "moved";

export interface LifecycleEvent {
    /** the mutation that produced it (drives the WS broadcast type in phase 2). */
    op: LifecycleOp;
    /** the message/event row. `kind` discriminates the lifecycle transition
     *  (ticket_created / comment_added / ticket_closed / decision …); `project`
     *  and `ticket_id` carry the routing context the rules engine needs. */
    message: Message;
}

export function emitLifecycle(event: LifecycleEvent): void {
    bus.emit("lifecycle", event);
}

export function onLifecycle(handler: (event: LifecycleEvent) => void): () => void {
    bus.on("lifecycle", handler);
    return () => bus.off("lifecycle", handler);
}
