/**
 * claude-loop `PermissionDenied` hook — #3500.
 *
 * Claude Code fires it when its permission system denies a tool call: the auto
 * mode classifier ("Permission for this action was denied by the Claude Code
 * auto mode classifier. Reason: …") and deny rules. Claude then stops on the
 * refusal, and nothing on the board said so. The kernel counts these denials
 * with time, for the bar's `⛔N·age` chip and the agent bar's `denials`.
 *
 * It changes no behaviour: it never asks for a retry (`retry: true`), it only
 * observes. Its payload is logged verbatim (cut) the first times, as the
 * Notification hook's was: the shape is documented, not yet measured here.
 *
 * Always emits `{}` and exits 0 — it must never affect a turn.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.js";
import { CL_ENV } from "./env-vars.js";
import { LOOP_SOCK_KIND, loopSockPath } from "./state.js";
import { sendEventOnce } from "./ipc-events.js";
import { emitHookEventToTimer } from "./hook-emit.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
const name = process.env[CL_ENV.NAME];
if (!sd || !name) emit();

// As the Notification hook: the line to the local file at once, and to the
// central loop.log awaited before exiting (an exit kills a pending send).
const pending: string[] = [];
const logger = createLogger({
    tag: `permission-denied-hook:${name}`,
    write: (line) => {
        pending.push(line);
        try { appendFileSync(join(sd!, "permission-denied-hook.log"), line); } catch { /* nowhere to log */ }
    },
});

async function flush(): Promise<void> {
    for (const line of pending) {
        try {
            await sendEventOnce(loopSockPath(sd!), { kind: LOOP_SOCK_KIND.LOG, data: { line } }, { timeoutMs: 100, throwOnError: false });
        } catch { /* timer down — the file is the fallback */ }
    }
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
}

const RAW_MAX = 2000;

try {
    const raw = (await readStdin()).trim();
    let parsed: Record<string, unknown> | null = null;
    try {
        const v: unknown = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object") parsed = v as Record<string, unknown>;
    } catch { /* raw is logged below regardless */ }
    const tool = typeof parsed?.tool_name === "string" ? parsed.tool_name : null;
    const reason = typeof parsed?.denial_reason === "string" ? parsed.denial_reason
        : typeof parsed?.reason === "string" ? parsed.reason : null;
    const keys = parsed ? Object.keys(parsed).sort().join(",") : "-";
    const cut = raw.length > RAW_MAX ? `${raw.slice(0, RAW_MAX)}…` : raw;
    logger.info(`permission denied tool=${tool ?? "?"} classifier_verdict=${parsed && "classifier_verdict" in parsed ? "yes" : "no"} keys=[${keys}] reason=${JSON.stringify(reason)} raw=${JSON.stringify(cut)}`);
    await flush();
    await emitHookEventToTimer(sd!, { event: "hook", kind: "PermissionDenied", tool_name: tool, reason, at_ms: Date.now() });
} catch (e) {
    logger.info(`permission denied READ FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await flush();
}
emit();
