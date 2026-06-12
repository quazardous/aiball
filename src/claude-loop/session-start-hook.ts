#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop SessionStart hook — slim signal emitter (#639 david `3yz6qa`
 * "Faut utiliser les pane Watchers et les state machine").
 *
 * Runs once when a claude session opens. Always emits `{}` to stdout and
 * exits 0 (never block claude's boot). Single job today : emit the
 * `SessionStart` event on the timer's loop.sock so the in-process
 * subscribers (IdleController, BootMachine modules) flip state. Boot
 * detection + picker auto-cross live LOOP-SIDE via the pane watchers
 * (timer.ts:`pickerSessionW`/`pickerModeW`) — the hook does NOT poll the
 * pane and does NOT send keys anymore.
 *
 * Previously :
 *   - polled the pane 15s for "Resume session" regex + send Enter
 *   - polled the pane 6s for "Resume from summary" regex + send Down/Enter
 *   - decided safeToSignal based on whether sessionPicked fired
 *
 * Today :
 *   - loop's pickerSessionW/pickerModeW watchers (PaneObserver) detect
 *     the same regex and the timer.ts subscriber sends keys directly
 *   - the BootMachine's `resume_picker`/`resume_mode` modules gate
 *     bar-boot state until the watchers end (= picker dismissed)
 *   - this hook just emits the SessionStart event and exits
 */
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { CL_ENV } from "./env-vars.js";
import { emitHookEventToTimer } from "./hook-emit.js";
import { sendEventOnce } from "./ipc-events.js";
import { LOOP_SOCK_KIND, loopSockPath } from "./state.js";
import { createLogger } from "../log.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
if (!sd || !name) emit();

// #944 Slice 1+2 : NDJSON via createLogger ; ship each line over
// loop.sock to the timer + dual-write to the local session-start-hook.log
// as cold-boot safety (timer may not be listening yet on a fresh session
// and the hook exits in ~50ms — no time to await the WS handshake).
const logger = createLogger({
    tag: `session-start-hook:${name}`,
    write: (line) => {
        void sendEventOnce(
            loopSockPath(sd!),
            { kind: LOOP_SOCK_KIND.LOG, data: { line } },
            { timeoutMs: 100, throwOnError: false },
        ).catch(() => { /* file fallback below */ });
        try {
            appendFileSync(join(sd!, "session-start-hook.log"), line);
        } catch { /* nowhere to log */ }
    },
});

function log(msg: string): void {
    logger.info(msg);
}

// Claude Code passes JSON on stdin with a `source` field
// (startup / resume / clear / compact).
let source = "startup";
try {
    const raw = readFileSync(0, "utf8");
    if (raw) source = (JSON.parse(raw) as { source?: string }).source ?? source;
} catch { /* no stdin, assume startup */ }

if (source === "startup" || source === "resume" || source === "compact" || source === "clear") {
    try {
        const ok = await emitHookEventToTimer(sd!, {
            event: "hook",
            kind: "SessionStart",
            source,
            at_ms: Date.now(),
        });
        log(`emit SessionStart source=${source} ok=${ok}`);
    } catch (e) { log(`emit SessionStart error ${(e as Error).message ?? e}`); }
}
emit();
