/**
 * #845 Phase B — Tiny abstract base for the most common watcher shape :
 * `{ visible: boolean }`. Subclasses just implement `classify(paneText,
 * ctx)` ; the base handles event emission + listener bookkeeping.
 *
 * Most watchers extracted from `refreshPaneMarkers` fit this pattern :
 * picker-session, picker-mode, resuming, compact-confirm, prompt, busy,
 * interrupted. The compacting watcher (already shipped in Phase A) is
 * the exception — it has a latch + ctx.isBoot and keeps its own class.
 */

import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./types.js";

export interface BoolWatcherState {
    visible: boolean;
}

export abstract class BoolWatcher implements PaneWatcher<BoolWatcherState> {
    abstract readonly name: string;
    private state: BoolWatcherState = { visible: false };
    private listeners: {
        change: Array<(next: BoolWatcherState, prev: BoolWatcherState | null) => void>;
        begin: Array<(s: BoolWatcherState) => void>;
        end: Array<(s: BoolWatcherState) => void>;
        progress: Array<(s: BoolWatcherState) => void>;
    } = { change: [], begin: [], end: [], progress: [] };

    /** Subclass contract : pure classifier on the pane text + ctx. */
    protected abstract classify(paneText: string, ctx: PaneScanCtx): boolean;

    observe(paneText: string, ctx: PaneScanCtx): BoolWatcherState {
        const raw = this.classify(paneText, ctx);
        const prev = this.state;
        if (prev.visible === raw) return prev;
        const next: BoolWatcherState = { visible: raw };
        this.state = next;
        this.emit("change", next, prev);
        if (!prev.visible && next.visible) this.emit("begin", next);
        if (prev.visible && !next.visible) this.emit("end", next);
        return next;
    }

    snapshot(): BoolWatcherState { return this.state; }

    on<E extends keyof PaneWatcherEvents<BoolWatcherState>>(
        event: E,
        cb: NonNullable<PaneWatcherEvents<BoolWatcherState>[E]>,
    ): () => void {
        const list = this.listeners[event as keyof typeof this.listeners];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (list as Array<any>).push(cb);
        return () => {
            const idx = list.indexOf(cb as never);
            if (idx >= 0) list.splice(idx, 1);
        };
    }

    reset(): void {
        this.state = { visible: false };
        this.listeners = { change: [], begin: [], end: [], progress: [] };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private emit(event: keyof typeof this.listeners, ...args: any[]): void {
        for (const cb of this.listeners[event]) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (cb as any)(...args);
            } catch { /* listener isolation */ }
        }
    }
}
