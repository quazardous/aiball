/**
 * #845 — PaneObserver : zone registry + tick dispatcher. "Manager actif"
 * per david's split — it holds zones and the active set, but never
 * decides on its own.
 *
 * Lifecycle :
 *   - `registerZone(zone)`   — add a zone to the registry. No-op if a
 *                              zone with the same name already exists
 *                              (replaces the previous one — last writer
 *                              wins for clean test setup).
 *   - `enter(name)`          — activate a zone. Future ticks dispatch to
 *                              its watchers.
 *   - `leave(name)`          — deactivate.
 *   - `tick(paneText, ctx)`  — for each ACTIVE zone, iterate its watchers
 *                              and call `observe()`. Watchers belonging
 *                              to multiple active zones are observed only
 *                              once per tick (dedup via a `seen` set —
 *                              david : "un watcher peut être multi-zone").
 *
 * Errors thrown by a watcher are caught and isolated — one watcher
 * crashing must not block the tick for the others.
 */

import type { Zone } from "./zone.js";
import type { PaneScanCtx, PaneWatcher } from "./types.js";

export class PaneObserver {
    private zones = new Map<string, Zone>();
    private active = new Set<string>();

    registerZone(zone: Zone): void {
        this.zones.set(zone.name, zone);
    }

    /** Activate a zone. Unknown names are ignored silently — the state
     *  machine may enter a zone before the observer registered it during
     *  bootstrap. The tick will skip it until it's registered. */
    enter(name: string): void {
        this.active.add(name);
    }

    leave(name: string): void {
        this.active.delete(name);
    }

    /** Transition helper : leave a set then enter another in one call.
     *  Use when the SM swaps modes (boot → runtime). */
    transition(leaveNames: string[], enterNames: string[]): void {
        for (const n of leaveNames) this.active.delete(n);
        for (const n of enterNames) this.active.add(n);
    }

    isActive(name: string): boolean {
        return this.active.has(name);
    }

    activeZones(): string[] {
        return Array.from(this.active);
    }

    /** Dispatch a single pane scan to every watcher in every active zone.
     *  Watchers that appear in more than one active zone observe once. */
    tick(paneText: string, ctx: PaneScanCtx): void {
        const seen = new Set<PaneWatcher<unknown>>();
        for (const name of this.active) {
            const z = this.zones.get(name);
            if (!z) continue;
            for (const w of z.watchers) {
                if (seen.has(w)) continue;
                seen.add(w);
                try {
                    w.observe(paneText, ctx);
                } catch {
                    /* watcher isolation : one crash doesn't take the tick down */
                }
            }
        }
    }
}
