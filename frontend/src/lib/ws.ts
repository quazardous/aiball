import { ref, onBeforeUnmount } from "vue";

import type { Message, Strategy } from "./api";
import { subscribeBus } from "./api";

export type WsEvent =
    | { type: "message_created"; data: Message }
    | { type: "message_decided"; data: Message }
    | { type: "message_edited"; data: Message }
    | { type: "message_noted"; data: Message }
    | { type: "message_tagged"; data: Message }
    | { type: "rule_changed"; data: unknown }
    | { type: "automation_rule_changed"; data: unknown }
    | { type: "tag_changed"; data: unknown }
    | { type: "strategy_changed"; data: { strategy: Strategy } }
    | { type: "project_deleted"; data: { project: string; deleted_messages: number } }
    // Bulk purge of old closed tickets inside a project (settings action).
    | { type: "project_purged"; data: { project: string } }
    // Project renamed from the settings page.
    | { type: "project_renamed"; data: { old: string; new: string } }
    // A consumer's live state changed: loop state push (dedup'd daemon-side),
    // presence flip on SSE open/close, or consumer CRUD. Previously undeclared
    // — the event reached the relay through the JSON cast and was handled by
    // the message fallthrough by accident.
    | { type: "consumer_changed"; data: unknown };

/**
 * The board's live events, `{ type, data }`. #3068 — read from the bus subject
 * `board.events` on the page's one connection, where the page used to open
 * `/ws`: the events are the same. After a reconnect the missed ones come
 * first, when the daemon still holds them; `connected` goes back to true once
 * subscribed again.
 */
export function useWs(onEvent: (e: WsEvent) => void) {
    const connected = ref(false);
    const sub = subscribeBus("board.events", (data) => onEvent(data as WsEvent), {
        onActive: (active) => { connected.value = active; },
    });
    onBeforeUnmount(() => sub.close());
    return { connected };
}
