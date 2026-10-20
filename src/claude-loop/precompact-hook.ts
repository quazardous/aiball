/**
 * claude-loop `PreCompact` hook — #4051.
 *
 * Claude Code runs it when a compaction starts, manual (`/compact`) or
 * automatic (the context is full). The screen does not always show it: on
 * helios an auto-compaction drew nothing the loop recognises for a minute, the
 * loop read the prompt as idle, and four wakes queued behind it. This hook says
 * it deterministically; the kernel counts Claude as busy until the compaction's
 * SessionStart(compact) or the next Stop.
 *
 * Observes only: it never blocks the compaction. Always emits `{}` and exits 0.
 */
import { readFileSync } from "node:fs";
import { CL_ENV } from "./env-vars.js";
import { emitHookEventToTimer } from "./hook-emit.js";

function emit(): never {
    process.stdout.write("{}\n");
    process.exit(0);
}

const sd = process.env[CL_ENV.STATE_DIR];
if (!sd) emit();

let trigger: string | undefined;
try {
    const raw = readFileSync(0, "utf8");
    const parsed = raw ? (JSON.parse(raw) as { trigger?: unknown }) : null;
    if (typeof parsed?.trigger === "string") trigger = parsed.trigger;
} catch { /* no payload: the start is news enough */ }

try {
    await emitHookEventToTimer(sd!, { event: "hook", kind: "PreCompact", at_ms: Date.now(), ...(trigger ? { trigger } : {}) });
} catch { /* best effort: a lost event costs the busy proof, never the compaction */ }
emit();
