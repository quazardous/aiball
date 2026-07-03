/**
 * WebSocket → bus relay for the inbox + thread views (extracted from
 * App.vue in #B.213 phase A.3 on 2026-05-19).
 *
 * The actual socket plumbing lives in lib/ws.ts (`useWs`); this module
 * is the App.vue-side dispatcher that turns raw WS events into the
 * typed bus events the rest of the SFC tree subscribes to:
 *
 *   - `rule_changed` / `tag_changed`           → rules.refresh / tags.refresh
 *   - `message_tagged`                         → thread.refresh + inbox.refresh
 *   - `strategy_changed`                       → updates `strategy` ref inline
 *   - `project_deleted`                        → project.deleted + projects.refresh + inbox.refresh
 *   - `message_created` / `message_decided` /
 *     `message_edited` / `message_noted`       → message.arrived/decided + thread.refresh + inbox.refresh + projects.refresh
 *
 * Also catches up after a reconnect (mobile freeze etc) by emitting
 * inbox.refresh + projects.refresh so any event the socket missed is
 * picked up by the next loadRows / loadProjects pass.
 *
 * Returns `{ connected }` so the caller can render a status pip.
 */
import { watch } from "vue";
import type { Ref } from "vue";
import { useWs } from "./ws";
import { bus } from "./bus";
import { STRATEGIES, type Message, type Strategy } from "./api";

export function useInboxWs(opts: {
    strategy: Ref<Strategy>;
    openTicketId: Ref<number | null>;
}) {
    const { strategy, openTicketId } = opts;

    const { connected } = useWs((ev) => {
        if (ev.type === "rule_changed") {
            bus.emit("rules.refresh");
            return;
        }
        if (ev.type === "automation_rule_changed") {
            bus.emit("automation.refresh");
            return;
        }
        if (ev.type === "tag_changed") {
            // Tag catalog touched (rename, color, delete) — refresh the
            // tags panel and any open TagPicker. Don't touch inbox/projects
            // here: the catalog change doesn't move per-project counts.
            bus.emit("tags.refresh");
            return;
        }
        if (ev.type === "message_tagged") {
            // A message gained/lost tags. The catalog itself is unchanged,
            // but the open thread (if it contains this message) and the
            // inbox row need to redraw their tag chips. The server sends
            // `{ message_id, tags }` — no ticket_id — so we trigger a
            // defensive thread.refresh on whatever's currently open, plus
            // an inbox refresh. Cheap and self-correcting.
            const tagged = ev.data as { message_id?: number; ticket_id?: number } | undefined;
            if (tagged?.ticket_id !== undefined) {
                bus.emit("thread.refresh", { ticketId: tagged.ticket_id });
            } else if (openTicketId.value !== null) {
                bus.emit("thread.refresh", { ticketId: openTicketId.value });
            }
            bus.emit("inbox.refresh");
            return;
        }
        if (ev.type === "strategy_changed") {
            const s = (ev.data as { strategy?: Strategy } | undefined)?.strategy;
            if (s && (STRATEGIES as readonly string[]).includes(s)) strategy.value = s;
            return;
        }
        if (ev.type === "consumer_changed") {
            // Dedicated lane: a loop presence/state event repaints the
            // consumer surfaces only. The old fallthrough emitted
            // inbox.refresh + projects.refresh on EVERY heartbeat of every
            // loop — a full inbox refetch per loop per minute.
            bus.emit("consumers.refresh");
            return;
        }
        if (ev.type === "project_deleted") {
            const deleted = (ev.data as { project?: string } | undefined)?.project;
            if (deleted) bus.emit("project.deleted", { project: deleted });
            bus.emit("projects.refresh");
            bus.emit("inbox.refresh");
            return;
        }
        // Remaining events are message-shaped (`message_created`,
        // `message_decided`, `message_edited`, `message_noted`).
        const data = ev.data as Message | undefined;
        if (!data || typeof data !== "object") return;
        if (ev.type === "message_created") bus.emit("message.arrived", data);
        else if (ev.type === "message_decided") bus.emit("message.decided", data);
        if (data.ticket_id !== null && data.ticket_id !== undefined) {
            bus.emit("thread.refresh", { ticketId: data.ticket_id });
        }
        if (data.kind === "ticket_created") {
            bus.emit("thread.refresh", { ticketId: data.id });
        }
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
    });

    // Catch up after a WS reconnect (mobile freeze most commonly) —
    // any event missed while the socket was down won't replay (#B.191).
    watch(connected, (now, prev) => {
        if (now && prev === false) {
            bus.emit("inbox.refresh");
            bus.emit("projects.refresh");
            bus.emit("consumers.refresh");
        }
    });

    return { connected };
}
