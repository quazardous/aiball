/**
 * #845 — A Zone is just a NAMED BAG of watchers. No state, no activation
 * logic, no events.
 *
 * The orchestrator (`PaneObserver`) holds a registry of zones plus a set
 * of active zone names. The state machine drives which zones are active
 * by calling `enter(name)` / `leave(name)` on the observer. The Zone
 * itself is intentionally inert — that's the whole point of the
 * "watcher dumb, orchestrator dumb, SM smart" split (david `9kjxad`).
 */

import type { PaneWatcher } from "./types.js";

export class Zone {
    readonly name: string;
    readonly watchers: ReadonlyArray<PaneWatcher<unknown>>;

    constructor(name: string, watchers: PaneWatcher<unknown>[]) {
        this.name = name;
        this.watchers = watchers.slice();
    }
}
