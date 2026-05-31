/**
 * #633 Slice F (david `yau5jc`) — pure-ish dispatcher for the proxy→timer
 * back-channel events. Extracted from timer.ts's inline closure so it's
 * unit-testable with a tmp state-dir + node --test (no live timer, no
 * spawn). The dispatcher reads the LoopState input, decides what to do
 * based on the AUTHORITATIVE bootComplete marker, and calls the right
 * state.ts mutator.
 *
 * Event shapes (newline-delimited JSON over `proxy-events.sock`) :
 *   { event: "keystroke", kind: "typing",   now_ms: <ms> }
 *   { event: "keystroke", kind: "afk_key",  now_ms: <ms> }
 *   { event: "marker",    name: "touch_marker"|"touch_user_grace"|"clear_user_grace", now_ms: <ms> }
 *   { event: "marker",    name: "set_afk_10m", expiry_ms: <ms>, now_ms: <ms> }  (#653)
 *   { event: "marker",    name: "set_afk_inf", now_ms: <ms> }                   (#653)
 *   { event: "marker",    name: "clear_afk",   now_ms: <ms> }                   (#653)
 *
 * Unknown event kinds are logged + ignored (forward-compatible : a future
 * proxy emitting a new kind doesn't crash an old timer).
 */
import {
    armAfk10m,
    clearUserGrace,
    readLoopStateInput,
    toggleAfk,
    touchHumanTyping,
    touchUserGrace,
} from "./state.js";
import { computeLoopView } from "./loop-state.js";
import { armAfkViaService, clearAfkViaService, setAfkInfViaService } from "./afk-service-sync.js";

/** Verdict surfaced for logging + tests. Caller logs the string ;
 *  null means the event was unknown / no-op. */
export type DispatchVerdict =
    | { kind: "typing-armed" }
    | { kind: "typing-skipped-boot" }
    | { kind: "afk-toggled"; nextMode: "off" | "wait_10m" | "wait_inf" }
    | { kind: "marker-touched"; name: "touch_marker" | "touch_user_grace" | "clear_user_grace" }
    | { kind: "afk-service-set"; mode: "off" | "wait_10m" | "wait_inf"; expiryMs: number | null }
    | { kind: "unknown"; raw: string }
    | { kind: "error"; message: string };

/** Pure-ish dispatcher : reads `sd` markers, mutates them via state.ts.
 *  Returns a Verdict so the caller (timer.ts) can log it consistently,
 *  and tests can assert exact branches without parsing log strings. */
export function dispatchProxyEvent(sd: string, event: Record<string, unknown>): DispatchVerdict {
    try {
        const kind = event.event;
        const eventKind = event.kind;
        if (kind === "keystroke" && eventKind === "typing") {
            // Typing arms NOT AFK 10m only when boot has actually settled
            // (bootComplete marker exists OR equivalent state). The bus's
            // pushed view doesn't gate here — readLoopStateInput +
            // computeLoopView consult bootComplete directly.
            const view = computeLoopView(readLoopStateInput(sd));
            if (view.inBootGrace) return { kind: "typing-skipped-boot" };
            armAfk10m(sd);
            return { kind: "typing-armed" };
        }
        if (kind === "keystroke" && eventKind === "afk_key") {
            // F9 cycles 3 states (off → 10m → ∞ → off). No boot guard :
            // the user explicitly pressed F9.
            toggleAfk(sd);
            const nextMode = readLoopStateInput(sd).afkMode;
            return { kind: "afk-toggled", nextMode };
        }
        if (kind === "marker") {
            const name = event.name;
            if (name === "touch_marker") {
                touchHumanTyping(sd);
                return { kind: "marker-touched", name };
            }
            if (name === "touch_user_grace") {
                touchUserGrace(sd);
                return { kind: "marker-touched", name };
            }
            if (name === "clear_user_grace") {
                clearUserGrace(sd);
                return { kind: "marker-touched", name };
            }
            // #653 step 2 — AFK mutations from the proxy. Dispatcher is
            // now the SINGLE WRITER : via-service helpers update the
            // AfkService AND write the marker file in one call. The
            // proxy stopped writing the file in step 2 (it emits these
            // events instead) ; degraded-mode (no proxy connection) is
            // covered by the proxy's fallback path which writes the
            // file directly when emit() returns false.
            if (name === "set_afk_10m") {
                const exp = typeof event.expiry_ms === "number" ? event.expiry_ms : NaN;
                if (!Number.isFinite(exp)) return { kind: "unknown", raw: `marker:set_afk_10m (missing expiry_ms)` };
                // armAfkViaService takes seconds, but the event carries
                // an absolute expiry — convert back so the helper writes
                // the right ISO timestamp.
                const secondsFromNow = Math.max(0, Math.round((exp - Date.now()) / 1000));
                armAfkViaService(sd, secondsFromNow);
                return { kind: "afk-service-set", mode: "wait_10m", expiryMs: exp };
            }
            if (name === "set_afk_inf") {
                setAfkInfViaService(sd);
                return { kind: "afk-service-set", mode: "wait_inf", expiryMs: null };
            }
            if (name === "clear_afk") {
                clearAfkViaService(sd);
                return { kind: "afk-service-set", mode: "off", expiryMs: null };
            }
            return { kind: "unknown", raw: `marker:${String(name)}` };
        }
        return { kind: "unknown", raw: `${String(kind)}:${String(eventKind)}` };
    } catch (e) {
        return { kind: "error", message: (e as Error).message ?? String(e) };
    }
}

/** Human-readable log line for a verdict — same shape the legacy inline
 *  handler emitted, so existing grep / monitoring keeps working. */
export function formatVerdictLogLine(v: DispatchVerdict): string {
    switch (v.kind) {
        case "typing-armed":         return "proxy-event: typing → armed NOT AFK 10m";
        case "typing-skipped-boot":  return "proxy-event: typing during boot → no arm (state.inBootGrace)";
        case "afk-toggled":          return `proxy-event: afk_key → toggled to ${v.nextMode}`;
        case "marker-touched":       return `proxy-event: marker '${v.name}' applied`;
        case "afk-service-set":      return `proxy-event: AfkService → ${v.mode}${v.expiryMs !== null ? ` (expiry=${new Date(v.expiryMs).toISOString()})` : ""}`;
        case "unknown":              return `proxy-event: unknown '${v.raw}'`;
        case "error":                return `proxy-event handler error: ${v.message}`;
    }
}
