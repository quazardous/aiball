/**
 * #845 Phase B — Error watcher : detects rate-limit / api-error /
 * overloaded screens in the pane footer. Different shape from the
 * bool watchers because the relevant signal is WHICH error id is
 * active, not a boolean.
 *
 * The current state carries the latest matched id (or null). Events :
 *   - `change(next, prev)` — anytime the id changes (including null →
 *     id, id → other-id, id → null).
 *   - `begin(state)`       — null → id (a new error appeared).
 *   - `end(state)`         — id → null (the error went away).
 *
 * id → other-id (e.g. rate-limit → overloaded) fires `change` only ;
 * neither `begin` nor `end` since the error stream stays active.
 *
 * Consumers (timer.ts) currently call `armErrorBackoff` / `resetErrorBackoff`
 * directly from `refreshPaneMarkers`. The watcher is a parallel observer
 * for the new architecture — the legacy call sites stay until the SM
 * subscribes to `begin`/`end` instead (Phase C).
 */

import { matchPaneError } from "../error-backoff.js";
import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./types.js";

export interface ErrorState {
    errorId: string | null;
}

export class ErrorWatcher implements PaneWatcher<ErrorState> {
    readonly name = "error";
    private state: ErrorState = { errorId: null };
    private listeners: {
        change: Array<(next: ErrorState, prev: ErrorState | null) => void>;
        begin: Array<(s: ErrorState) => void>;
        end: Array<(s: ErrorState) => void>;
        progress: Array<(s: ErrorState) => void>;
    } = { change: [], begin: [], end: [], progress: [] };

    observe(paneText: string, _ctx: PaneScanCtx): ErrorState {
        const raw = matchPaneError(paneText);
        const prev = this.state;
        if (prev.errorId === raw) return prev;
        const next: ErrorState = { errorId: raw };
        this.state = next;
        this.emit("change", next, prev);
        if (prev.errorId === null && next.errorId !== null) this.emit("begin", next);
        if (prev.errorId !== null && next.errorId === null) this.emit("end", next);
        return next;
    }

    snapshot(): ErrorState { return this.state; }

    on<E extends keyof PaneWatcherEvents<ErrorState>>(
        event: E,
        cb: NonNullable<PaneWatcherEvents<ErrorState>[E]>,
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
        this.state = { errorId: null };
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
