/**
 * #652 Slice 3 — best-effort hook → timer event emitter.
 *
 * Hooks (session-start-hook, stop-hook, pretooluse-hook) are spawn-
 * per-call subprocesses that run in the same `$CL_STATE_DIR` as the
 * long-running timer. The timer binds a UDS at
 * `proxyEventsSockPath(sd)` to listen for back-channel events (#633 :
 * the proxy already pushes typing / afk_key / marker events). Slice 3
 * adds the hook process as another writer to the SAME socket — events
 * land in `proxy-event-dispatcher.ts:dispatchProxyEvent` which now
 * recognises `event: "hook"` and forwards to the in-process
 * `HookService`.
 *
 * Implementation : open a UDS client, send one newline-delimited JSON
 * line, close. Async because hooks live in an async main(). If the
 * timer isn't there (degraded mode / standalone hook test) the emit
 * silently no-ops — the hook keeps its existing behaviour as fallback.
 */
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { proxyEventsSockPath } from "./state.js";

/**
 * One-shot emit of a single event to the timer. Resolves true on
 * confirmed send (the bytes are written and the connection is closed
 * cleanly), false on any failure (socket absent, timer not listening,
 * write error, timeout). Caller treats false as "fall back to in-
 * process logic" — the hook stays correct even when the timer is
 * down.
 */
export function emitHookEventToTimer(
    sd: string,
    event: Record<string, unknown>,
    timeoutMs = 300,
): Promise<boolean> {
    const sockPath = proxyEventsSockPath(sd);
    if (!existsSync(sockPath)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        const payload = JSON.stringify(event) + "\n";
        let sock: ReturnType<typeof createConnection>;
        try {
            sock = createConnection(sockPath);
        } catch {
            return settle(false);
        }
        const timer = setTimeout(() => {
            try { sock.destroy(); } catch { /* race */ }
            settle(false);
        }, timeoutMs);
        sock.setNoDelay(true);
        sock.on("connect", () => {
            sock.write(payload, "utf8", (err) => {
                clearTimeout(timer);
                if (err) {
                    try { sock.destroy(); } catch { /* race */ }
                    settle(false);
                    return;
                }
                try { sock.end(); } catch { /* race */ }
                settle(true);
            });
        });
        sock.on("error", () => {
            clearTimeout(timer);
            settle(false);
        });
    });
}
