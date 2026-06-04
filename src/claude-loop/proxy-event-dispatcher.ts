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
    readLoopStateInput,
    toggleAfk,
    touchHumanTyping,
} from "./state.js";
import { computeLoopView } from "./loop-state.js";
import { armAfkViaService, clearAfkViaService, setAfkInfViaService } from "./afk-service-sync.js";
import { getIpcState, setIpcLastOpenWakeCount, setIpcLastWakeAtMs, setIpcWakeRequested } from "./ipc-state.js";
import { WAKE_IN_FLIGHT_TTL_MS } from "./state.js";
import { getHookService, type HookEvent } from "./hook-service.js";

/** Verdict surfaced for logging + tests. Caller logs the string ;
 *  null means the event was unknown / no-op. */
export type DispatchVerdict =
    | { kind: "typing-armed" }
    | { kind: "typing-skipped-boot" }
    | { kind: "afk-toggled"; nextMode: "off" | "wait_10m" | "wait_inf" }
    | { kind: "marker-touched"; name: "touch_marker" | "touch_user_grace" | "clear_user_grace" | "set_last_open_wake_count" | "set_last_wake_at" | "set_wake_requested" }
    | { kind: "afk-service-set"; mode: "off" | "wait_10m" | "wait_inf"; expiryMs: number | null }
    | { kind: "hook-event"; hookEvent: HookEvent }
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
            // #745 phase B — touch_user_grace / clear_user_grace events
            // are no-ops on the dispatcher side now ; user-grace was a
            // strict duplicate of the AFK SM (typing arms NOT AFK 10m,
            // F9 cycles release it). The proxy may still emit them for
            // a release ; we accept the kind silently for forward-compat.
            if (name === "touch_user_grace" || name === "clear_user_grace") {
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
            // V4 Phase 2 — the stop-hook subprocess pushes the new
            // `last-open-wake-count` watermark via this marker so the
            // timer's in-memory IpcState reflects the cross-process
            // update without ever round-tripping through a file.
            if (name === "set_last_open_wake_count") {
                const count = typeof event.count === "number" ? event.count : NaN;
                if (!Number.isFinite(count) || count < 0) {
                    return { kind: "unknown", raw: `marker:set_last_open_wake_count (bad count ${String(event.count)})` };
                }
                setIpcLastOpenWakeCount(Math.max(0, Math.floor(count)));
                return { kind: "marker-touched", name };
            }
            // V4 Phase 3 — wake-at timestamp pushed from the stop-hook
            // subprocess so the timer's in-memory shadow stays current.
            if (name === "set_last_wake_at") {
                const at = typeof event.at_ms === "number" ? event.at_ms : NaN;
                if (!Number.isFinite(at)) {
                    return { kind: "unknown", raw: `marker:set_last_wake_at (bad at_ms ${String(event.at_ms)})` };
                }
                setIpcLastWakeAtMs(at);
                return { kind: "marker-touched", name };
            }
            // V5 Phase A — `claude-loop wake <name>` CLI subprocess pushes
            // a wake-request flag via this marker. The timer's wake gate
            // reads `IpcState.wakeRequestedAtMs` instead of the file
            // marker (no fs round-trip + no degraded mode coupling on
            // the CLI side).
            if (name === "set_wake_requested") {
                const at = typeof event.at_ms === "number" ? event.at_ms : Date.now();
                setIpcWakeRequested(at);
                return { kind: "marker-touched", name };
            }
            return { kind: "unknown", raw: `marker:${String(name)}` };
        }
        // #652 Slice 3 — hook events from spawn-per-call subprocesses
        // (session-start-hook, stop-hook, pretooluse-hook). The hook
        // process emits via emitHookEventToTimer (UDS client) and we
        // dispatch into the in-process HookService here. Subscribers
        // on the service (bar / wake gate / future state machine)
        // pick them up.
        if (kind === "hook") {
            const hookKind = event.kind;
            const atMs = typeof event.at_ms === "number" ? event.at_ms : Date.now();
            if (hookKind === "SessionStart") {
                const rawSource = event.source;
                const source = rawSource === "startup" || rawSource === "resume" || rawSource === "compact" || rawSource === "clear"
                    ? rawSource
                    : null;
                if (!source) return { kind: "unknown", raw: `hook:SessionStart (bad source ${String(rawSource)})` };
                // #727 V1 Slice B-2 — propagate picker context if the hook
                // reported it. Absent fields fall through ; the subscriber
                // doesn't mutate the in-memory picker flags when undefined.
                const hookEvent: HookEvent = {
                    kind: "SessionStart",
                    source,
                    at_ms: atMs,
                    ...(typeof event.picker_session === "boolean" ? { picker_session: event.picker_session } : {}),
                    ...(typeof event.picker_mode === "boolean" ? { picker_mode: event.picker_mode } : {}),
                };
                getHookService().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "Stop") {
                // #727 V1 Slice B-2 — Stop ships busy-defer expiry when the
                // hook arms a defer (pane busy at turn end). Undefined when
                // the pane is idle — no defer needed.
                const busyDeferUntilMs = typeof event.busy_defer_until_ms === "number"
                    ? event.busy_defer_until_ms
                    : event.busy_defer_until_ms === null
                        ? null
                        : undefined;
                const hookEvent: HookEvent = {
                    kind: "Stop",
                    at_ms: atMs,
                    ...(busyDeferUntilMs !== undefined ? { busy_defer_until_ms: busyDeferUntilMs } : {}),
                };
                getHookService().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "PreToolUse") {
                const toolName = typeof event.tool_name === "string" ? event.tool_name : null;
                if (!toolName) return { kind: "unknown", raw: `hook:PreToolUse (missing tool_name)` };
                const hookEvent: HookEvent = { kind: "PreToolUse", tool_name: toolName, at_ms: atMs };
                getHookService().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "UserPromptSubmit") {
                // #778 david `3p3tp5` : derive from_auto_wake from IPC state
                // instead of the wake-in-flight file marker. The hook
                // subprocess just sends `at_ms` ; here we compare with the
                // timer's `ipcState.lastWakeAtMs` (set by sendKeys + stop-
                // hook on every send-keys). Within WAKE_IN_FLIGHT_TTL_MS,
                // the prompt is our own auto-wake. Fallback : if the hook
                // legacy sent `from_auto_wake` explicitly (e.g. file-marker
                // path during transition), honor it.
                let fromAutoWake = event.from_auto_wake === true;
                if (!fromAutoWake) {
                    const lastWake = getIpcState().lastWakeAtMs;
                    if (lastWake !== null && (atMs - lastWake) < WAKE_IN_FLIGHT_TTL_MS) {
                        fromAutoWake = true;
                    }
                }
                const hookEvent: HookEvent = { kind: "UserPromptSubmit", from_auto_wake: fromAutoWake, at_ms: atMs };
                getHookService().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            return { kind: "unknown", raw: `hook:${String(hookKind)}` };
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
        case "hook-event":           return `proxy-event: HookService ← ${v.hookEvent.kind}${v.hookEvent.kind === "SessionStart" ? ` (source=${v.hookEvent.source})` : v.hookEvent.kind === "PreToolUse" ? ` (tool=${v.hookEvent.tool_name})` : v.hookEvent.kind === "UserPromptSubmit" ? ` (from_auto_wake=${v.hookEvent.from_auto_wake})` : ""}`;
        case "unknown":              return `proxy-event: unknown '${v.raw}'`;
        case "error":                return `proxy-event handler error: ${v.message}`;
    }
}
