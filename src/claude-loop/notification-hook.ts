/**
 * claude-loop `Notification` hook — #1315 S0, a SPIKE.
 *
 * It changes no behaviour. Its only job is to record what Claude Code actually
 * sends, because the whole ticket rests on facts nobody has observed yet:
 * which notification types fire inside a loop, and WHEN.
 *
 * A `Notification` is a signal Claude Code emits OUTWARD (Claude Code → you),
 * like a desktop notification or the terminal bell. It is side-effect only —
 * it cannot block, and exit 2 is ignored — so aiball can only ever observe it.
 *
 * What S0 has to answer, before any of S1's mapping is written:
 *
 *   1. Which types actually arrive. The docs list `idle_prompt`,
 *      `agent_needs_input`, `permission_prompt`, `auth_success`,
 *      `elicitation_*`, `agent_completed` — read, not measured. This hook is
 *      registered with NO matcher precisely so a type nobody anticipated still
 *      lands in the record.
 *   2. Whether `idle_prompt` fires at the exact end of a turn or after an
 *      inactivity threshold. That decides whether it can corroborate the `Stop`
 *      hook's turn-end (the real one today) or only says "idle has settled".
 *      Answering it needs Notification lines and Stop lines on ONE timeline,
 *      which is why this logs through the central logger rather than a sink of
 *      its own: `claude-loop log` already interleaves them.
 *
 * The payload is logged VERBATIM alongside the parsed fields. A spike that
 * records only the fields it thought to name would answer question 1 with its
 * own assumptions.
 *
 * Always emits `{}` and exits 0 — it must never affect a turn.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.js";
import { CL_ENV } from "./env-vars.js";
import { LOOP_SOCK_KIND, loopSockPath } from "./state.js";
import { queryLoopState } from "./hook-verdict.js";
import { sendEventOnce } from "./ipc-events.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
if (!sd || !name) emit();

// Dual sink, like `stop-hook.ts`: the local file, and the UDS LOG channel that
// puts the line in the central `loop.log` — where it can be read against the
// Stop lines, which is the whole point of a timeline.
//
// The file write is synchronous; the UDS one is not, and that difference cost
// the first run of this spike. `stop-hook` fires-and-forgets because it keeps
// working afterwards, so its socket write has time to leave. This hook logs and
// exits immediately, and `process.exit` killed every pending send: 0 of 4 lines
// reached the centre while all 4 reached the file.
//
// So the line is buffered here and delivered with an AWAIT before exiting.
const pending: string[] = [];
const logger = createLogger({
    tag: `notification-hook:${name}`,
    write: (line) => {
        pending.push(line);
        try { appendFileSync(join(sd!, "notification-hook.log"), line); } catch { /* nowhere to log */ }
    },
});

/** Deliver the buffered lines to the timer, then give up quietly. The file
 *  already has them, so a down timer costs visibility, never data. */
async function flushToTimer(): Promise<void> {
    for (const line of pending) {
        try {
            await sendEventOnce(
                loopSockPath(sd!),
                { kind: LOOP_SOCK_KIND.LOG, data: { line } },
                { timeoutMs: 100, throwOnError: false },
            );
        } catch { /* timer down — the file is the fallback */ }
    }
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * #1315 — `idle_prompt` as an independent witness that the session is at rest.
 *
 * Measured before this was written, which changed what it is for. Across four
 * loops on 2026-08-27, `idle_prompt` landed 61.0-61.4 s after the last `Stop`,
 * four times out of four; the `Stop`s that produced none were each followed by
 * another `Stop` inside that minute, resetting the count. So it is NOT a
 * turn-end corroboration — `Stop` already marks that, exactly, a minute
 * earlier. It is an inactivity threshold: "nothing has happened for ~60 s".
 *
 * That makes it useless for sharpening busy -> idle, and useful for the
 * opposite: catching the moment our own busy flag is LYING. The pane-scraped
 * latch goes stale in practice — `clearing stale paneBusy latch` appears 20
 * times in one day across the loops — and today that is only noticed when
 * `turn:settled` happens to fire. Claude Code reporting a minute of quiet
 * while our phase still reads busy is proof the latch is stale, from a source
 * that cannot be fooled by pane text.
 *
 * Reads through `queryLoopState`, NOT `readLoopStateInput` directly. A hook is
 * a fresh subprocess, so its `ipcState` is empty until the UDS round-trip
 * mirrors the timer's into it; reading directly returns safe defaults, which
 * here means `paneBusy: false` and a detector that can never fire. The first
 * version of this did exactly that and its smoke test "passed" — the reassuring
 * line was the default, not a reading.
 *
 * Which is also why an unreachable timer is reported as UNKNOWN rather than as
 * agreement. `queryLoopState` degrades silently to those same defaults, so
 * "idle" from a dead socket and "idle" from a live one are indistinguishable
 * downstream — and only one of them is evidence.
 *
 * This REPORTS and changes nothing. No rule is rewritten, no latch is cleared:
 * a detector earns trust in the log before anything acts on it, and a hook must
 * never affect a turn.
 */
async function reportQuiescenceMismatch(type: string): Promise<void> {
    if (type !== "idle_prompt") return;
    try {
        if (!existsSync(loopSockPath(sd!))) {
            logger.info(`notification idle_prompt: loop state UNKNOWN (no timer socket) — not evidence either way`);
            return;
        }
        const state = await queryLoopState(sd!);
        if (state.phase === "busy") {
            logger.info(
                `notification idle_prompt WHILE state=busy — the busy latch is stale`
                + ` (claude reports ~60s of quiet ; nothing is cleared here)`,
            );
        } else {
            logger.info(`notification idle_prompt agrees with state=${state.phase}`);
        }
    } catch (e) {
        // Never let an observation break the hook.
        logger.info(`notification idle_prompt: state read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

try {
    const raw = (await readStdin()).trim();
    // Parse for greppable fields, but never let a parse failure lose the bytes:
    // an unparseable payload is itself the finding.
    let parsed: Record<string, unknown> | null = null;
    try {
        const v: unknown = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object") parsed = v as Record<string, unknown>;
    } catch { /* raw is logged below regardless */ }

    // Do NOT enumerate the type field's expected values — the point is to see
    // what arrives. We only surface the keys Claude Code is documented to use
    // for identification, and fall back to the whole payload otherwise.
    const type = parsed
        ? String(parsed.notification_type ?? parsed.notificationType ?? parsed.type ?? "?")
        : "?";
    const keys = parsed ? Object.keys(parsed).sort().join(",") : "-";
    logger.info(`notification type=${type} keys=[${keys}] raw=${JSON.stringify(raw)}`);
    await reportQuiescenceMismatch(type);
    await flushToTimer();
} catch (e) {
    logger.info(`notification READ FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await flushToTimer();
}
emit();
