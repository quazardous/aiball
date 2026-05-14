/**
 * Tiny in-house event bus for the aiball frontend.
 *
 * Single, typed event channel that components subscribe to via `useBus()`
 * (auto-unsubscribes at unmount). The WebSocket relay and local actions
 * `emit()` high-level intent events on it; consumers (sidebar, list,
 * thread view, toaster…) react to the events they care about without
 * App.vue having to wire them by hand.
 *
 * Why not Pinia / mitt / an external lib (e.g. quarkernel): the
 * frontend has ~15 components, Vue 3 reactivity covers most of the
 * state-sharing surface, and the only orthogonal need is "fire and
 * forget" intent events. ~40 lines of plain TS + a Vue helper match
 * the scope without adding a dep.
 *
 * Adding a new event:
 *   1. Add a key in `BusEvents` with its payload type.
 *   2. Emit somewhere with `bus.emit("my.event", payload)`.
 *   3. Subscribe somewhere with `useBus("my.event", (payload) => …)`.
 *
 * The map-driven design means TypeScript will tell you at compile time
 * if you typo an event name or pass the wrong payload shape.
 */

import { onBeforeUnmount } from "vue";
import type { Message } from "./api";

/** Typed event map — augment this to add new bus events. */
export interface BusEvents {
    /** The inbox aggregate (per-ticket rows) should be refreshed. */
    "inbox.refresh": void;
    /** The per-project stats (sidebar badges) should be refreshed. */
    "projects.refresh": void;
    /** The open thread should reload its data, if it matches the ticket id. */
    "thread.refresh": { ticketId: number };
    /** The moderation rules list should be refreshed (RulesPanel). */
    "rules.refresh": void;
    /** The tag catalog should be refreshed (TagsPanel, any TagPicker). */
    "tags.refresh": void;
    /** Any new message landed in the system (approved or pending). */
    "message.arrived": Message;
    /** A pending message was approved or rejected by a moderator. */
    "message.decided": Message;
    /** A project was deleted server-side; consumers should drop references. */
    "project.deleted": { project: string };
    /** Read state for a ticket flipped; sidebar/list badges may need refresh. */
    "read-state.changed": { ticket_id: number; consumer_id: string; unread: boolean };
    /** A `- [ ]` question was clicked in a rendered body (#B.104). The
     *  composer subscribes, appends a quote of the question text, and
     *  records the pair so the eventual submit toggles the checkbox
     *  via the answer endpoint after the reply lands. */
    "composer.add-answer": {
        messageId: number;
        questionId: string;
        questionText: string;
    };
}

type BusHandler<K extends keyof BusEvents> =
    BusEvents[K] extends void
        ? () => void
        : (payload: BusEvents[K]) => void;

type AnyHandler = (payload: unknown) => void;

class Bus {
    private listeners = new Map<keyof BusEvents, Set<AnyHandler>>();

    /**
     * Subscribe to an event. Returns an `off()` function that removes
     * the handler — call it when you're done (or use `useBus()` to get
     * automatic cleanup at component unmount).
     */
    on<K extends keyof BusEvents>(ev: K, handler: BusHandler<K>): () => void {
        let set = this.listeners.get(ev);
        if (!set) {
            set = new Set();
            this.listeners.set(ev, set);
        }
        set.add(handler as AnyHandler);
        return () => {
            set!.delete(handler as AnyHandler);
        };
    }

    /**
     * Emit an event. All currently-subscribed handlers run synchronously
     * in subscription order. Errors in one handler don't stop the others.
     */
    emit<K extends keyof BusEvents>(
        ev: K,
        ...args: BusEvents[K] extends void ? [] : [BusEvents[K]]
    ): void {
        const set = this.listeners.get(ev);
        if (!set) return;
        const payload = args[0] as unknown;
        for (const handler of set) {
            try {
                handler(payload);
            } catch (e) {
                // Log and keep going — one buggy consumer must not break
                // the rest of the chain. This is the central bus, so a
                // crash here would silently kill UI reactivity downstream.
                console.error(`[bus] handler for "${String(ev)}" threw:`, e);
            }
        }
    }
}

/** App-wide singleton. Import as `import { bus } from "@/lib/bus"`. */
export const bus = new Bus();

/**
 * Vue helper: subscribe inside a `setup()` and auto-unsubscribe at
 * component teardown. Returns the manual unsubscribe in case the
 * caller wants to detach earlier.
 */
export function useBus<K extends keyof BusEvents>(
    ev: K,
    handler: BusHandler<K>,
): () => void {
    const off = bus.on(ev, handler);
    onBeforeUnmount(off);
    return off;
}
