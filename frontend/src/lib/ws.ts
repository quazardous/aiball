import { ref, onBeforeUnmount } from "vue";

import type { Message, Strategy } from "./api";

export type WsEvent =
    | { type: "message_created"; data: Message }
    | { type: "message_decided"; data: Message }
    | { type: "message_edited"; data: Message }
    | { type: "message_noted"; data: Message }
    | { type: "message_tagged"; data: Message }
    | { type: "rule_changed"; data: unknown }
    | { type: "tag_changed"; data: unknown }
    | { type: "strategy_changed"; data: { strategy: Strategy } }
    | { type: "project_deleted"; data: { project: string; deleted_messages: number } };

export function useWs(onEvent: (e: WsEvent) => void) {
    const connected = ref(false);
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;

    function connect() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}/ws`;
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

    // #B.191: mobile browsers (iOS Safari, Android Chrome) freeze
    // background tabs and silently drop long-lived sockets when
    // backgrounded for more than ~30s. The internal close handler
    // does re-arm via exponential backoff, but david observed inbox
    // rows never refreshing after a phone sleep — likely because the
    // close event itself was suppressed by the freeze, leaving the
    // socket in a half-dead `OPEN` state. visibilitychange handles
    // that explicitly: when the tab comes back, if the socket is
    // anything other than freshly-OPEN, drop it and reconnect now
    // (no waiting for the backoff timer).
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
