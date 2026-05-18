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
 *     Payload: `{ ticket_id?: number, comment_id?: number }`.
 *
 * Keep this layer dumb: just a typed emitter. SSE filtering, batching,
 * keepalives all live in the consumer (api.ts). New event kinds get
 * added here as their emit-point lands.
 */
import { EventEmitter } from "node:events";

export interface PingEvent {
    ticket_id?: number;
    comment_id?: number;
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
