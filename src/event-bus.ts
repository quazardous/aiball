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
import { fanOutPings } from "./notifications.js";

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
 * #442/#451 — out-of-band CONTROL events pushed to a consumer's live SSE stream
 * (the loop already holds one open). Distinct from `ping` (work-arrival): this
 * is the daemon telling a specific loop to act on itself. Same per-recipient
 * routing as pings. Actions:
 *   - `kill`   (#442) — hard stop (the loop self-rm's).
 *   - `prompt` (#451) — inject a raw, unfiltered prompt `text` straight into the
 *                       loop's Claude session (a "wake" with operator-supplied
 *                       text instead of a ping phrase). Privileged — see
 *                       loop-control.ts (moderator-only, no proxy nodes).
 */
export type ControlEvent =
    | { action: "kill" }
    | { action: "prompt"; text: string };

export function emitControl(recipient: string, payload: ControlEvent): void {
    bus.emit(`control:${recipient}`, payload);
}

export function onControl(
    recipient: string,
    handler: (payload: ControlEvent) => void,
): () => void {
    const key = `control:${recipient}`;
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
export type LifecycleOp =
    | "created"
    | "decided"
    | "edited"
    | "moved"
    | "tagged"
    // #509 — state-change ops séparés du générique `edited` pour que les
    // subscribers (notamment l'automation runtime) dispatchent sans avoir à
    // diff l'avant/après eux-mêmes. Chaque op porte sa valeur old sur le
    // LifecycleEvent (champs `old_priority` / `old_project` / `old_status`).
    | "priority_changed"
    | "status_changed";

export interface LifecycleEvent {
    /** the mutation that produced it (drives the WS broadcast type in phase 2). */
    op: LifecycleOp;
    /** the message/event row. `kind` discriminates the lifecycle transition
     *  (ticket_created / comment_added / ticket_closed / decision …); `project`
     *  and `ticket_id` carry the routing context the rules engine needs. */
    message: Message;
    /** #457 slice 2 — when `op === "tagged"` : the tag name JUST added to
     *  `message` (which is the ticket row, kind=ticket_created). Drives the
     *  automation engine's `match_tag_added` lever. Absent for other ops. */
    added_tag?: string;
    /** #457 slice 2 — when `op === "tagged"` : every tag currently on the
     *  ticket AFTER the change. Drives `match_tags` any-of. */
    all_tags?: string[];
    /** #509 — when `op === "priority_changed"` : the priority value BEFORE
     *  the mutation. The new value lives on `message.priority`. */
    old_priority?: string;
    /** #509 — when `op === "moved"` : the project source BEFORE the move.
     *  The new project is on `message.project`. */
    old_project?: string;
    /** #509 — when `op === "status_changed"` : the moderation status BEFORE
     *  the transition. Typically `"pending"` since the modérateur decide()
     *  path gates on existing.status === "pending". */
    old_status?: string;
}

export function emitLifecycle(event: LifecycleEvent): void {
    bus.emit("lifecycle", event);
}

export function onLifecycle(handler: (event: LifecycleEvent) => void): () => void {
    bus.on("lifecycle", handler);
    return () => bus.off("lifecycle", handler);
}

/**
 * #836 Phase 1 — Single entry point for "a new event has landed".
 *
 * Wraps the duo `fanOutPings(message) + emitLifecycle({op, message, …})`
 * that historically scattered across every callsite (`messages.ts` ~6
 * sites, `moveTicketTo`, `close-cleanup.ts`, …). Each callsite used to
 * decide on its own whether to call one, both, or only emit lifecycle
 * after the ping fanout. Drift inevitable.
 *
 * `pushEvent(msg, {op})` codifies the matrix : every event that goes
 * through pushEvent gets BOTH side-effects in the right order. Callers
 * only need to provide the lifecycle op (default `"created"`) + any
 * old-value context (move source, prior priority, …).
 *
 * NOT for : the WS `broadcast()` call — that's a separate concern (live
 * UI announce, not server-side reaction). Callers keep broadcast inline
 * because not every internal lifecycle event needs broadcasting and
 * vice-versa.
 */
export interface PushEventOpts {
    op?: LifecycleOp;
    old_priority?: string;
    old_project?: string;
    old_status?: string;
    added_tag?: string;
    all_tags?: string[];
}

export function pushEvent(message: Message, opts: PushEventOpts = {}): void {
    fanOutPings(message);
    emitLifecycle({
        op: opts.op ?? "created",
        message,
        old_priority: opts.old_priority,
        old_project: opts.old_project,
        old_status: opts.old_status,
        added_tag: opts.added_tag,
        all_tags: opts.all_tags,
    });
}
