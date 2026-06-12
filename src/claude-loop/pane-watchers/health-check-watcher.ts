/**
 * #850 — Health-check watcher : one-shot detection of a 1-5 digit
 * self-rating in the pane text post-boot. The timer injects a prompt
 * post-boot via the `post_boot_health_check` slot ; claude responds
 * (typically with a single digit), and this watcher captures it.
 *
 * Design : pure observer of the last few lines of the pane. Once a
 * digit is captured, the watcher is "armed off" and never re-observes
 * (one-shot per session — david plan `3wfee3`). Reset() is for tests
 * only.
 *
 * Score → bar segment `H:N` colored red (1-2), yellow (3), green (4-5).
 * Consumer (BarRenderer + IPC bridge) reads via the `change` event.
 */
import type { PaneScanCtx, PaneWatcher, PaneWatcherEvents } from "./types.js";

export interface HealthCheckState {
    /** 1-5 = captured rating, null = not captured yet. */
    score: number | null;
}

/** Scan the last N footer lines for the first standalone digit 1-5.
 *  Standalone = bounded by start/end of line OR whitespace. Excludes
 *  digits in URLs, ticket refs (`#NNN`), counts (`x42`), etc. */
function findStandaloneScore(paneText: string, footerLines = 12): number | null {
    const lines = paneText.split("\n").slice(-footerLines);
    // Iterate in reverse — claude's most recent response is at the
    // bottom. Stop at the first match.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // Skip prompt input lines (start with `❯` or `>`) — they're the
        // user's prompt area, not claude's response.
        const trimmed = line.trim();
        if (trimmed.startsWith("❯") || trimmed.startsWith(">")) continue;
        // Match a bare digit 1-5 either alone on the line or preceded
        // by a typical assistant prefix marker (●, ✻, ➤).
        const bareMatch = /^([1-5])$/.exec(trimmed);
        if (bareMatch) return Number(bareMatch[1]);
        const prefixMatch = /^[●✻➤]\s*([1-5])\b/.exec(trimmed);
        if (prefixMatch) return Number(prefixMatch[1]);
    }
    return null;
}

export class HealthCheckWatcher implements PaneWatcher<HealthCheckState> {
    readonly name = "health-check";
    private state: HealthCheckState = { score: null };
    private listeners: {
        change: Array<(next: HealthCheckState, prev: HealthCheckState | null) => void>;
        begin: Array<(s: HealthCheckState) => void>;
        end: Array<(s: HealthCheckState) => void>;
        progress: Array<(s: HealthCheckState) => void>;
        seen: Array<(s: HealthCheckState) => void>;
    } = { change: [], begin: [], end: [], progress: [], seen: [] };

    observe(paneText: string, _ctx: PaneScanCtx): HealthCheckState {
        // One-shot — once captured, never re-observe.
        if (this.state.score !== null) return this.state;
        const score = findStandaloneScore(paneText);
        if (score === null) return this.state;
        const prev = this.state;
        const next: HealthCheckState = { score };
        this.state = next;
        this.emit("change", next, prev);
        this.emit("begin", next);
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
        this.state = { score: null };
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

/** Internal export for unit tests — exercise the regex without
 *  spinning a full watcher. */
export const _findStandaloneScoreForTests = findStandaloneScore;
