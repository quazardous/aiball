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
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.js";
import { CL_ENV } from "./env-vars.js";
import { LOOP_SOCK_KIND, loopSockPath } from "./state.js";
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
    await flushToTimer();
} catch (e) {
    logger.info(`notification READ FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await flushToTimer();
}
emit();
