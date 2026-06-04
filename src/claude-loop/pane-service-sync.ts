/**
 * #647 Slice 3 — bridge between the legacy marker-file model (state.ts)
 * and the typed in-memory PaneService (slice 1). On each heartbeat, the
 * timer calls `syncPaneServiceFromMarkers(sd)` to mirror the file
 * existence into the singleton service ; the bar (slice 4) then reads
 * `getPaneService().snapshot()` instead of `existsSync(...)` x N.
 *
 * Why dual-write? The marker files remain the cross-process source of
 * truth (session-start-hook writes them from a different process).
 * PaneService is in-memory per-process — useful for the timer's own
 * consumers (bar, future subscribers). Slice 5 will bridge the hook →
 * timer via proxy-events.sock so the hook can push directly. Slice 6
 * drops the files.
 *
 * Living here (not in state.ts) so state.ts doesn't grow another import
 * and to keep the dependency direction clean : pane-service-sync depends
 * on both state and pane-service, never the reverse.
 */
import { existsSync } from "node:fs";
import {
    resumeModePickerActivePath,
    resumeSessionPickerActivePath,
} from "./state.js";
import { getIpcState } from "./ipc-state.js";
import {
    ERROR_GROUP,
    PaneMarker,
    SCREEN_TAKEOVER_GROUP,
    getPaneService,
    type PaneService,
} from "./pane-service.js";

/** Map the `error-backoff.ts:ERROR_PATTERNS` id strings to PaneMarker
 *  enum values. Keep in sync if a new pattern is added. */
function errorIdToMarker(id: string | null): PaneMarker | null {
    switch (id) {
        case "rate-limit": return PaneMarker.ErrorRateLimit;
        case "overloaded": return PaneMarker.ErrorOverloaded;
        case "api-error": return PaneMarker.ErrorApiError;
        default: return null;
    }
}

/**
 * Pull every pane-derived marker file under `sd` and mirror their
 * presence into the PaneService singleton. Pass `errId` to also sync
 * the error group (null → clear). Idempotent — only transitions notify
 * subscribers (PaneService's `set` is no-op on equal values).
 *
 * Called from `refreshPaneMarkers` after the existing file setters
 * fire ; so the files are already in sync by the time we read them.
 */
export function syncPaneServiceFromMarkers(
    sd: string,
    opts: { errId?: string | null } = {},
): PaneService {
    const svc = getPaneService();
    const ipc = getIpcState();
    // #733 V2 — boolean pane signals come straight from `ipcState`. Same
    // process as `refreshPaneMarkers`, so the values are fresh by the time
    // we read them. `null` (cold boot, before the first probe) is treated
    // as `false`.
    const busy = ipc.paneBusy ?? false;
    const ready = ipc.paneReady ?? false;
    const resuming = ipc.paneResuming ?? false;
    const compacting = ipc.paneCompacting ?? false;
    svc.set(PaneMarker.Busy, busy);
    svc.set(PaneMarker.Ready, ready);
    // PaneReady doubles as the ready marker today (no separate probe-
    // initial signal) ; track Ready and PaneReady the same.
    svc.set(PaneMarker.PaneReady, ready);

    // Screen-takeover group — picker files still live (V1 hooks write
    // them), pane resuming/compacting come from ipcState. The emitter
    // (session-start-hook + refreshPaneMarkers) guarantees only one is
    // set at a time, but defensively we pick first-match order
    // session > mode > resuming > compacting and clear the rest via
    // setExclusive.
    const session = existsSync(resumeSessionPickerActivePath(sd));
    const mode = existsSync(resumeModePickerActivePath(sd));
    let takeover: PaneMarker | null = null;
    if (session) takeover = PaneMarker.ResumeSessionPicker;
    else if (mode) takeover = PaneMarker.ResumeModePicker;
    else if (resuming) takeover = PaneMarker.Resuming;
    else if (compacting) takeover = PaneMarker.Compacting;
    svc.setExclusive(SCREEN_TAKEOVER_GROUP, takeover);

    // Error group — caller passes the matchPaneError(paneText) result.
    // Undefined = don't touch (keep last known) ; null = clear ;
    // string = set the matching marker.
    if (opts.errId !== undefined) {
        const errMarker = errorIdToMarker(opts.errId);
        svc.setExclusive(ERROR_GROUP, errMarker);
    }

    return svc;
}
