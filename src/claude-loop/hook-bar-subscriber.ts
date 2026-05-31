/**
 * #652 Slice 6 — timer-side subscriber on the HookService that owns the
 * tmux bar paint for hook events the hooks no longer paint themselves.
 *
 * Today's coverage :
 *   - `UserPromptSubmit` → `setTmuxStatus(name, BUSY)`. Replaces the
 *     direct paint that lived in user-prompt-submit-hook.ts ;
 *     the hook now just emits the event and the subscriber paints,
 *     so the in-process state-machine sees the same signal a future
 *     consumer (wake gate, metrics) needs.
 *
 * Scope intentionally narrow : the stop-hook's 8 contextual paints
 * (BUSY with retry / compacting / IDLE with sub-state / etc.) are NOT
 * migrated here — replicating them via a subscriber would require the
 * Stop event to carry the decision context (substate, reason), which
 * is a bigger refactor (slice 7 territory). The Stop event still fires
 * via slice 5 ; the stop-hook keeps its own paints for now.
 */
import { setTmuxStatus, LOOP_STATUS, type LoopStatus } from "./state.js";
import { getHookService, type HookEvent } from "./hook-service.js";

export interface HookBarSubscription {
    /** Stop listening + tear the subscriber down (idempotent). */
    close(): void;
}

/**
 * Signature of the paint backend the subscriber drives. Mirrors the
 * real `setTmuxStatus` ; injected at install time so unit tests can
 * substitute a spy without going through tmux. Production callers
 * pass nothing and get `setTmuxStatus` from state.ts.
 */
export type BarPainter = (name: string, status: LoopStatus, sub?: string | number) => void;

/**
 * Wire the subscriber. Returns a `close()` handle so the timer's
 * shutdown path can clean up (mirrors `createProxyEventsServer`).
 * Idempotent close ; calling twice is a no-op. The `painter` parameter
 * defaults to `setTmuxStatus` ; tests pass a spy.
 */
export function installHookBarSubscriber(name: string, painter: BarPainter = setTmuxStatus): HookBarSubscription {
    const unsub = getHookService().subscribe((event: HookEvent) => {
        try {
            paintFromEvent(name, event, painter);
        } catch { /* observer model — never crash the timer */ }
    });
    let closed = false;
    return {
        close(): void {
            if (closed) return;
            closed = true;
            try { unsub(); } catch { /* ignore */ }
        },
    };
}

/**
 * Pure mapping `event → bar paint`. Exported for testing without the
 * subscriber wiring overhead — call `paintFromEvent(name, event, painter)`
 * to exercise a single transition with an injected paint backend.
 */
export function paintFromEvent(name: string, event: HookEvent, painter: BarPainter = setTmuxStatus): void {
    if (event.kind === "UserPromptSubmit") {
        // Claude is about to process the prompt — flip the bar BUSY
        // immediately. The previous stop-hook would later flip back to
        // IDLE when the turn ends.
        painter(name, LOOP_STATUS.BUSY);
        return;
    }
    // SessionStart / Stop / PreToolUse : no paint here yet. SessionStart
    // is owned by the timer's bootEnded handler ; Stop is owned by the
    // legacy stop-hook paint (slice 7 future) ; PreToolUse doesn't
    // change bar state on its own.
}
