import { ref, onBeforeUnmount } from "vue";

import type { Message, Strategy } from "./api";
import { withBase } from "./base";

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

export function useWs(onEvent: (e: WsEvent) => void) {
    const connected = ref(false);
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;

    function connect() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}${withBase("/ws")}`;
        ws = new WebSocket(url);
        ws.onopen = () => {
            connected.value = true;
            retry = 1000;
        };
        ws.onclose = () => {
            connected.value = false;
            ws = null;
            if (!stopped) {
                setTimeout(connect, retry);
                retry = Math.min(retry * 2, 10_000);
            }
        };
        ws.onerror = () => ws?.close();
        ws.onmessage = (m) => {
            try {
                onEvent(JSON.parse(m.data) as WsEvent);
            } catch {
                /* ignore */
            }
        };
    }

    // Force-reconnect on tab visibility — mobile browsers freeze
    // background tabs and the close event can be suppressed,
    // leaving the socket zombie-OPEN. Don't wait for backoff (#B.191).
    function onVisible() {
        if (document.visibilityState !== "visible") return;
        if (stopped) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            // Either we have no socket (reconnect in flight or
            // backed off) or we have one in a non-OPEN state.
            // Cancel the current one and reconnect immediately.
            if (ws) {
                try { ws.close(); } catch { /* noop */ }
                ws = null;
            }
            retry = 1000;
            connect();
        }
    }
    if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisible);
    }

    connect();
    onBeforeUnmount(() => {
        stopped = true;
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisible);
        }
        ws?.close();
    });

    return { connected };
}
