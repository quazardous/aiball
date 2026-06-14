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
    readLoopStateInput,
    toggleAfk,
    touchHumanTyping,
} from "./state.js";
import { armAfkViaService, clearAfkViaService, setAfkInfViaService } from "./afk-service-sync.js";
import { getAfkService } from "./afk-service.js";
import { getIpcState, setIpcLastWakeAtMs, setIpcWakeInFlightAtMs, setIpcWakeRequested } from "./ipc-state.js";
import { WAKE_IN_FLIGHT_TTL_MS } from "./state.js";
import { getHookWatcher, type HookWatcherEvent, type SessionStartSource } from "./hook-watcher.js";

/** Verdict surfaced for logging + tests. Caller logs the string ;
 *  null means the event was unknown / no-op. */
export type DispatchVerdict =
    | { kind: "typing-armed" }
    | { kind: "typing-skipped-inf" }
    | { kind: "afk-toggled"; nextMode: "off" | "wait_10m" | "wait_inf" }
    | { kind: "marker-touched"; name: "touch_marker" | "touch_user_grace" | "clear_user_grace" | "set_last_wake_at" | "set_wake_requested" | "set_wake_in_flight" }
    | { kind: "afk-service-set"; mode: "off" | "wait_10m" | "wait_inf"; expiryMs: number | null }
    | { kind: "hook-event"; hookEvent: HookWatcherEvent }
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
            // #951 david `xn9hfp` : drop le boot-grace gate. Le filtre
            // initial (typing skip pendant boot) datait de #633 Slice F
            // (ea23af3, mai 2026) — défensif baked-in sans bug justifiant.
            // Side-effect : un user qui tapait pendant boot n'armait pas
            // NOT AFK 10m → l'inject post-boot collidait avec sa frappe.
            // #965 david `<chat>` 2026-06-14 : les frappes synthétiques
            // (auto-cross resume picker, self-interrupt, wake) doivent
            // transiter par `inject.sock` (canal séparé du stdin proxy
            // donc invisible au typing detector), pas par `tmux send-keys`
            // qui rentre dans le stdin du proxy = indistinguable d'un
            // humain. Le `recentlySentKeys` legacy est obsolète (cf.
            // pty-proxy.py:24).
            const input = readLoopStateInput(sd);
            // #834 david — NOT AFK ∞ is an explicit human commitment ("je
            // suis là sur la durée"). Typing within that mode is expected,
            // NOT a fresh signal to re-bound the window. Pre-fix, every
            // keystroke re-armed wait_10m, silently downgrading the user's
            // ∞ choice. Preserve wait_inf untouched ; only arm 10m when
            // the current mode is off / wait_10m.
            if (input.afkMode === "wait_inf") return { kind: "typing-skipped-inf" };
            // #751 4asyze + cma67g — typing arms wait_10m via the SERVICE
            // helper (= file + AfkService observable + ipc.afkMode), NOT
            // the raw `armAfk10m` file-only path. Without the AfkService
            // update the bar chip painter (timer.ts:afkSub) never fires
            // and the "NOT AFK 10m" chip stays stuck on its previous value
            // until the next 1s safety tick. The SERVICE helper also
            // unifies the "arm" semantic across F9 commit (via toggle) and
            // direct keystroke (this path) — both reach the SM the same
            // way. No debounce on typing : david "frappe direct doit
            // directement passer en NOT AFK 10m (autre logique)".
            armAfkViaService(sd, 600);
            return { kind: "typing-armed" };
        }
        if (kind === "keystroke" && eventKind === "afk_key") {
            // F9 cycles 3 states (off → 10m → ∞ → off). No boot guard :
            // the user explicitly pressed F9. #876 — toggleAfk sends an
            // ARM_X debounced event to the AfkController actor. Read the
            // resulting snapshot to surface the user's choice (= the
            // pending mode while still in debounce, the committed mode
            // once the 3s window elapses).
            toggleAfk(sd);
            const snap = getAfkService().getActor().getSnapshot();
            const v = String(snap.value);
            const nextMode: "off" | "wait_10m" | "wait_inf" =
                v === "off" || v === "pending_off" ? "off"
                : v === "wait_10m" || v === "pending_10m" ? "wait_10m"
                : "wait_inf";
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
            // V4 Phase 3 — wake-at timestamp pushed from the stop-hook
            // subprocess so the timer's in-memory shadow stays current.
            // #840 `4z59jt` — IPC seul.
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
            // #840 `4z59jt` — IPC seul. Le stop-hook subprocess émet ce
            // marker ; le timer le matérialise en ipcState. Les hooks lisent
            // via UDS queryLoopState (= récupèrent cet ipc).
            if (name === "set_wake_in_flight") {
                const at = typeof event.at_ms === "number" ? event.at_ms : Date.now();
                setIpcWakeInFlightAtMs(at);
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
                // #893 Slice D — émet direct vers HookWatcher.
                const hookEvent: HookWatcherEvent = {
                    type: "hook:session_start",
                    source: source as SessionStartSource,
                    atMs,
                    ...(typeof event.picker_session === "boolean" ? { pickerSession: event.picker_session } : {}),
                    ...(typeof event.picker_mode === "boolean" ? { pickerMode: event.picker_mode } : {}),
                };
                getHookWatcher().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "Stop") {
                const busyDeferUntilMs = typeof event.busy_defer_until_ms === "number"
                    ? event.busy_defer_until_ms
                    : event.busy_defer_until_ms === null
                        ? null
                        : undefined;
                const hookEvent: HookWatcherEvent = {
                    type: "hook:stop",
                    atMs,
                    ...(busyDeferUntilMs !== undefined ? { busyDeferUntilMs } : {}),
                };
                getHookWatcher().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "PreToolUse") {
                const toolName = typeof event.tool_name === "string" ? event.tool_name : null;
                if (!toolName) return { kind: "unknown", raw: `hook:PreToolUse (missing tool_name)` };
                const hookEvent: HookWatcherEvent = { type: "hook:pretooluse", toolName, atMs };
                getHookWatcher().emit(hookEvent);
                return { kind: "hook-event", hookEvent };
            }
            if (hookKind === "UserPromptSubmit") {
                // #778 — derive fromAutoWake from IPC lastWakeAtMs.
                let fromAutoWake = event.from_auto_wake === true;
                if (!fromAutoWake) {
                    const lastWake = getIpcState().lastWakeAtMs;
                    if (lastWake !== null && (atMs - lastWake) < WAKE_IN_FLIGHT_TTL_MS) {
                        fromAutoWake = true;
                    }
                }
                const hookEvent: HookWatcherEvent = { type: "hook:user_prompt_submit", fromAutoWake, atMs };
                getHookWatcher().emit(hookEvent);
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
        case "typing-skipped-inf":   return "proxy-event: typing → skipped (NOT AFK ∞ preserved)";
        case "afk-toggled":          return `proxy-event: afk_key → toggled to ${v.nextMode}`;
        case "marker-touched":       return `proxy-event: marker '${v.name}' applied`;
        case "afk-service-set":      return `proxy-event: AfkService → ${v.mode}${v.expiryMs !== null ? ` (expiry=${new Date(v.expiryMs).toISOString()})` : ""}`;
        case "hook-event":           return `proxy-event: HookWatcher ← ${v.hookEvent.type}${v.hookEvent.type === "hook:session_start" ? ` (source=${v.hookEvent.source})` : v.hookEvent.type === "hook:pretooluse" ? ` (tool=${v.hookEvent.toolName})` : v.hookEvent.type === "hook:user_prompt_submit" ? ` (from_auto_wake=${v.hookEvent.fromAutoWake})` : ""}`;
        case "unknown":              return `proxy-event: unknown '${v.raw}'`;
        case "error":                return `proxy-event handler error: ${v.message}`;
    }
}
