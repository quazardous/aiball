/**
 * #652 Slice 3 — best-effort hook → timer event emitter.
 *
 * Hooks (session-start-hook, stop-hook, pretooluse-hook) are spawn-
 * per-call subprocesses that run in the same `$CL_STATE_DIR` as the
 * long-running timer. The timer binds a ws server on `loopSockPath(sd)`
 * to listen for back-channel events (#633 : the proxy pushes typing /
 * afk_key / marker events on the same socket). The hook process is
 * another writer for the SAME socket — events land in
 * `proxy-event-dispatcher.ts:dispatchProxyEvent` which recognises
 * `event: "hook"` and forwards to the in-process `HookService`.
 *
 * #727 V1 Slice A — wire migration. Hooks now reach the timer via the
 * shared `ipc-events` ws layer (same envelope the proxy uses :
 * `{kind:"proxyEvent", data:<legacy hook event>}`). Before this fix the
 * emitter still sent raw newline-JSON, which the ws server silently
 * dropped post-#729 — hook events never reached the timer + HookService
 * was never notified. The wrap reuses the existing proxyEvent kind so
 * no dispatcher change is needed : the inner `event:"hook"` payload
 * lands in `dispatchProxyEvent` unchanged.
 */
import { existsSync } from "node:fs";
import { sendEventOnce } from "./ipc-events.js";
import { loopSockPath } from "./state.js";
import { appendOffload } from "./offload.js";

/**
 * One-shot emit of a single event to the timer. Resolves true on
 * confirmed send (the ws handshake + frame both completed), false on
 * any failure (socket absent, timer not listening, ws error, timeout).
 * Caller treats false as "fall back to in-process logic" — the hook
 * stays correct even when the timer is down.
 */
export async function emitHookEventToTimer(
    sd: string,
    event: Record<string, unknown>,
    timeoutMs = 300,
): Promise<boolean> {
    const sockPath = loopSockPath(sd);
    // #1032 S1 — a hook event that can't reach the timer (socket absent =
    // timer respawning on a code change, or send error) is the exact loss
    // behind "bar stuck busy" (a dropped Stop event never clears the latch).
    // Buffer it per-component so the reconnect drain replays it into the
    // central log (ts preserved) and we can SEE what was lost.
    const kind = String(event.kind ?? event.event ?? "hook");
    if (!existsSync(sockPath)) {
        appendOffload(sd, "hook", { kind, msg: "emitHookEventToTimer: loop.sock absent (timer down/respawning)", event });
        return false;
    }
    try {
        await sendEventOnce(
            sockPath,
            { kind: "proxyEvent", data: event },
            { timeoutMs, throwOnError: true },
        );
        return true;
    } catch (e) {
        appendOffload(sd, "hook", { kind, msg: `emitHookEventToTimer: send failed: ${(e as Error).message}`, event });
        return false;
    }
}
