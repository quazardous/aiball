/**
 * #949 — HealthCheckWatcher : pane observer for Claude Code's NATIVE
 * session-health feedback prompt ("How are you doing in this session?
 * Respond with ONLY a single digit 1-5"). Claude Code emits this on
 * its own cadence to collect user feedback for Anthropic ; we OBSERVE
 * its presence, we never inject it.
 *
 * David `<chat>` 2026-06-14 : « c'est nativement claude code qui
 * affiche ça pour check la session de l'utilisateur (feedback pour
 * anthropic) ». Earlier #850 design wrongly INJECTED this prompt —
 * dropped in #949.
 *
 * Scope (#949 ffgdce) : just DETECT + drive a state machine that LOGS
 * each visibility transition. The response digit capture is out of
 * scope for now — kept as a future hook on top of the same machine
 * if needed.
 *
 * Events :
 *   - `begin(state)` — prompt becomes visible in the footer
 *   - `end(state)`   — prompt no longer visible
 *   - `change(next, prev)` — both transitions
 */
import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./types.js";

/** Regex matching Claude Code's native health-check banner. Broad on
 *  purpose : Anthropic may revise the wording, and the leading
 *  question stem is the stable anchor. Case-insensitive. */
export const NATIVE_HEALTH_PROMPT_RE = /How are you doing in this session/i;

export interface HealthCheckState {
    /** True while the native prompt is visible in the footer. */
    visible: boolean;
}

/** Scan the last N footer lines for the native prompt. Returns true
 *  on the first match. Skips user-prompt lines (`> ` / `❯ `) so a
 *  human typing about the question doesn't trip the watcher. */
function isNativePromptVisible(paneText: string, footerLines = 12): boolean {
    const lines = paneText.split("\n").slice(-footerLines);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("❯") || trimmed.startsWith(">")) continue;
        if (NATIVE_HEALTH_PROMPT_RE.test(line)) return true;
    }
    return false;
}

export class HealthCheckWatcher implements PaneWatcher<HealthCheckState> {
    readonly name = "health-check";
    private state: HealthCheckState = { visible: false };
    private listeners: {
        change: Array<(next: HealthCheckState, prev: HealthCheckState | null) => void>;
        begin: Array<(s: HealthCheckState) => void>;
        end: Array<(s: HealthCheckState) => void>;
        progress: Array<(s: HealthCheckState) => void>;
        seen: Array<(s: HealthCheckState) => void>;
    } = { change: [], begin: [], end: [], progress: [], seen: [] };

    observe(paneText: string, _ctx: PaneScanCtx): HealthCheckState {
        const visible = isNativePromptVisible(paneText);
        const prev = this.state;
        if (prev.visible === visible) return prev;
        const next: HealthCheckState = { visible };
        this.state = next;
        this.emit("change", next, prev);
        if (!prev.visible && next.visible) this.emit("begin", next);
        if (prev.visible && !next.visible) this.emit("end", next);
        return next;
    }

    snapshot(): HealthCheckState { return this.state; }

    on<E extends keyof PaneWatcherEvents<HealthCheckState>>(
        event: E,
        cb: NonNullable<PaneWatcherEvents<HealthCheckState>[E]>,
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
        this.listeners = { change: [], begin: [], end: [], progress: [], seen: [] };
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

/** Test export — exercise the regex without spinning a full watcher. */
export const _isNativePromptVisibleForTests = isNativePromptVisible;
