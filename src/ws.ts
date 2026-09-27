/**
 * The board's events: every change the daemon announces. #3068 — clients hear
 * them on the bus (`src/bus/methods/subjects.ts` turns them into subjects,
 * `board.events` carries them as they are); the `/ws` socket that used to
 * relay them to the web UI is gone.
 */
export type WsEvent =
    | { type: "message_created"; data: unknown }
    | { type: "message_decided"; data: unknown }
    | { type: "message_edited"; data: unknown }
    | { type: "message_noted"; data: unknown }
    | { type: "message_tagged"; data: unknown }
    | { type: "rule_changed"; data: unknown }
    | { type: "automation_rule_changed"; data: unknown }
    | { type: "tag_changed"; data: unknown }
    | { type: "strategy_changed"; data: unknown }
    | { type: "project_deleted"; data: unknown }
    | { type: "project_renamed"; data: unknown }
    | { type: "project_purged"; data: unknown }
    | { type: "consumer_changed"; data: unknown }
    // #3030 — an agent's loop bar changed, or went stale (its loop stopped).
    | { type: "agent_bar"; data: unknown };

/** What hears every event: the bus. A listener never stops the broadcast. */
const listeners = new Set<(event: WsEvent) => void>();

export function onBroadcast(fn: (event: WsEvent) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function broadcast(event: WsEvent): void {
    for (const fn of listeners) {
        try { fn(event); } catch (e) { console.error("[ws] a broadcast listener failed:", e); }
    }
}
