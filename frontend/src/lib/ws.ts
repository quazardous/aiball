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

    connect();
    onBeforeUnmount(() => {
        stopped = true;
        ws?.close();
    });

    return { connected };
}
