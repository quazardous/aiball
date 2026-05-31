/**
 * #649 Slice 4 — bridge between the legacy `afk` marker file (state.ts)
 * and the typed AfkService (slice 2). On timer boot the loop hydrates
 * the in-memory AfkService from the file once, then keeps it in sync
 * via fs.watch on the marker — cross-process writes (PTY proxy F9, the
 * timer's own `armAfk10m` paths) are picked up automatically.
 *
 * One-way (file → service) by design : the file remains the cross-
 * process source of truth ; AfkService is the in-process observable
 * façade for subscribers (bar countdown, wake gate). Slice 5 will drop
 * the file by migrating every mutation path to AfkService + emitting
 * file writes from a single writeback, eliminating the dual-write race.
 *
 * Living here (not in afk-service.ts) so afk-service.ts stays pure data
 * and so the dependency direction stays clean : afk-service-sync depends
 * on both state.ts (file paths + readAfkState) and afk-service.ts
 * (service), never the reverse.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { afkPath, readAfkState } from "./state.js";
import { type AfkService, getAfkService } from "./afk-service.js";

/**
 * Read the afk marker file and reflect its state into the given
 * AfkService instance (singleton by default). Idempotent — calls
 * setOff/setInf/set10m which are no-ops when state already matches.
 * `set10m` updates expiryMs even when state was already wait_10m, so a
 * mid-countdown rewrite of the expiry is picked up.
 *
 * Safe to call at any time, including before any watcher is wired.
 */
export function hydrateAfkServiceFromMarker(sd: string, svc?: AfkService): AfkService {
    const s = svc ?? getAfkService();
    const st = readAfkState(sd);
    if (st.mode === "off") s.setOff();
    else if (st.mode === "wait_inf") s.setInf();
    else if (st.mode === "wait_10m" && st.expiryMs !== null) s.set10m(st.expiryMs);
    return s;
}

/**
 * Start watching the afk marker file and re-hydrate AfkService on every
 * change. Returns an unwatch function (stop the watcher + future writes
 * stop propagating). Safe to call before the file exists — node fs.watch
 * watches the parent dir's entry, so creation events also fire.
 *
 * Implementation note : fs.watch's exact semantics differ across OSes
 * (Linux inotify vs macOS FSEvents). We rely only on "some event fires
 * after a write" — the handler always reads the file fresh, so even
 * coalesced events end up consistent.
 */
export function watchAfkMarker(sd: string, svc?: AfkService): () => void {
    const s = svc ?? getAfkService();
    // Watch the parent dir (sd) instead of the file directly — this
    // survives unlink+recreate cycles (clearAfk + setAfkInfinite). We
    // filter by filename inside the handler.
    let watcher: FSWatcher | null = null;
    try {
        watcher = watch(sd, (_event, filename) => {
            // filename is null on some platforms — fall through to
            // re-hydrate anyway (cheap, idempotent).
            if (filename && filename !== "afk") return;
            try { hydrateAfkServiceFromMarker(sd, s); } catch { /* race */ }
        });
    } catch {
        // Watching may fail on weird FSes ; degrade to "hydrate-once" mode.
    }
    // Always hydrate once on setup, so the service is correct even if no
    // event ever fires (e.g. file existed before the watcher was armed).
    try { hydrateAfkServiceFromMarker(sd, s); } catch { /* best-effort */ }
    return (): void => {
        try { watcher?.close(); } catch { /* race */ }
    };
}

/**
 * Convenience : true when an afk marker file exists at all (independent
 * of mode). Cheap probe useful for boot decisions before the watcher
 * has had a chance to fire.
 */
export function afkMarkerExists(sd: string): boolean {
    return existsSync(afkPath(sd));
}
