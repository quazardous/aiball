#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop SessionStart hook — slim signal emitter (#639 david `3yz6qa`
 * "Faut utiliser les pane Watchers et les state machine").
 *
 * Runs once when a claude session opens. Always emits `{}` to stdout and
 * exits 0 (never block claude's boot). Single job today : emit the
 * `SessionStart` event on the timer's loop.sock so the in-process
 * subscribers (TurnController, BootMachine modules) flip state. Boot
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
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CL_ENV } from "./env-vars.js";
import { SESSION_ID_FILE, isValidUuid } from "./session-id.js";
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
// (startup / resume / clear / compact) + the `session_id` claude is using.
let source = "startup";
let sessionId: string | null = null;
try {
    const raw = readFileSync(0, "utf8");
    if (raw) {
        const p = JSON.parse(raw) as { source?: string; session_id?: string };
        source = p.source ?? source;
        sessionId = typeof p.session_id === "string" ? p.session_id : null;
    }
} catch { /* no stdin, assume startup */ }

// #1549 `auto` mode — persist the session id claude actually used to
// `<project cwd>/.aiball-session_id` so the next `claude-loop start` resumes
// THIS exact session (see resolveSession). Detection, not imposition: we let
// claude pick its id, then record it. No-op for legacy/managed/fixed (they
// already own the id up front). Best-effort — never blocks claude's boot.
if (process.env.AIBALL_SESSION_MODE === "auto" && sessionId && isValidUuid(sessionId)) {
    const projectCwd = process.env.AIBALL_PROJECT_CWD ?? process.cwd();
    try {
        writeFileSync(join(projectCwd, SESSION_ID_FILE), sessionId + "\n");
        log(`auto: persisted session id ${sessionId} → ${SESSION_ID_FILE}`);
    } catch (e) { log(`auto: persist session id failed ${(e as Error).message ?? e}`); }
}

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
