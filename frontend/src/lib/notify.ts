/**
 * #459 — single toast abstraction for the aiball admin UI.
 *
 * All in-app notifications go through this composable. Under the hood it
 * wraps PrimeVue's `useToast()` with semantic helpers and aiball-wide
 * standard `life` durations, so a future change of toast lib / a global
 * tweak (sound, log mirroring, severity filter, mute) lives in THIS file
 * alone instead of being scattered across every component.
 *
 * Usage :
 *
 *   const notify = useNotify();
 *   notify.success("Saved consumer");
 *   notify.error("Save failed", { detail: e.message });
 *   notify.info("Loop reconnected");
 *   notify.warn(`No live loop for ${id}`, { detail: "Spooled until reconnect.", life: 8000 });
 *
 * Defaults (override per call via `{ life: N }` when needed) :
 *   success → 3000 ms ; info → 4000 ms ; warn → 5000 ms ; error → 6000 ms
 *
 * Convention :
 * - `summary` = the headline (what happened, who/what it applies to).
 * - `detail`  = optional sub-line (the why / next step / error message).
 *
 * Anti-pattern this replaces : local `flash` refs rendered as a `<p>` next
 * to the action button (cf. #459 — survives nothing, breaks visual
 * consistency, can't queue). Always reach for `notify.*()` instead.
 *
 * Existing call sites still using `toast.add(...)` directly will be
 * migrated progressively ; this composable is the canonical entry point
 * for ALL new code.
 */
import { useToast } from "primevue/usetoast";

type Severity = "success" | "info" | "warn" | "error" | "secondary" | "contrast";

interface NotifyOpts {
    /** Secondary line rendered under the summary. */
    detail?: string;
    /** Override the default life (ms). */
    life?: number;
    /** Override the auto-picked severity. Rare — prefer the matching helper. */
    severity?: Severity;
}

const DEFAULT_LIFE: Record<"success" | "info" | "warn" | "error", number> = {
    success: 3000,
    info: 4000,
    warn: 5000,
    error: 6000,
};

export function useNotify() {
    const toast = useToast();

    function show(
        severity: "success" | "info" | "warn" | "error",
        summary: string,
        opts?: NotifyOpts,
    ): void {
        toast.add({
            severity: opts?.severity ?? severity,
            summary,
            detail: opts?.detail,
            life: opts?.life ?? DEFAULT_LIFE[severity],
        });
    }

    return {
        success: (summary: string, opts?: NotifyOpts): void => show("success", summary, opts),
        info: (summary: string, opts?: NotifyOpts): void => show("info", summary, opts),
        warn: (summary: string, opts?: NotifyOpts): void => show("warn", summary, opts),
        error: (summary: string, opts?: NotifyOpts): void => show("error", summary, opts),
    };
}
