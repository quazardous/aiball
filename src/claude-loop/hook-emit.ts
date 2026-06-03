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
 * NOTE (regression flag) : this emitter still uses raw newline-JSON
 * over a fresh UDS connection, but the server has been a ws server
 * since #729 phase 2. Raw bytes fail the ws handshake and are silently
 * dropped — hook events never reach the timer in this state. The fix is
 * to migrate this caller to `sendEventOnce` from `ipc-events`, wrapping
 * the payload as `{kind:"hookEvent", data:<legacy>}`. Tracked as the
 * scope of #727 (hooks UDS) which lands after the #730 consolidation.
 * For now this file just follows the loop.sock rename so the import
 * doesn't dangle ; the silent-drop behaviour is pre-existing.
 *
 * Implementation : open a UDS client, send one newline-delimited JSON
 * line, close. Async because hooks live in an async main().
 */
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { loopSockPath } from "./state.js";

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
    const sockPath = loopSockPath(sd);
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
