/**
 * claude-loop status line command — #3686.
 *
 * Claude Code runs it with its status line JSON on stdin; this is the one place
 * it gives the subscription's usage (`rate_limits`). It relays that to the
 * kernel, for the agent bar's `usage`, and runs the user's own status line
 * (its command arrives base64 as the first argument) with the same stdin, its
 * output and exit code passed through: what the user sees does not change.
 * Without one, it prints nothing, as a session without a status line shows none.
 */
import { spawn } from "node:child_process";
import { CL_ENV } from "./env-vars.js";
import { emitHookEventToTimer } from "./hook-emit.js";

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
}

function runUserStatusLine(command: string, stdin: string): Promise<number> {
    return new Promise((resolve) => {
        try {
            const child = spawn(command, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
            child.on("error", () => resolve(0));
            child.on("close", (code) => resolve(code ?? 0));
            child.stdin.on("error", () => { /* it did not read its stdin: fine */ });
            child.stdin.end(stdin);
        } catch { resolve(0); }
    });
}

async function relay(sd: string, raw: string): Promise<void> {
    try {
        const parsed = JSON.parse(raw) as { rate_limits?: unknown };
        await emitHookEventToTimer(sd, { event: "hook", kind: "StatusLine", rate_limits: parsed?.rate_limits ?? null, at_ms: Date.now() }, 200);
    } catch { /* no reading this time */ }
}

const raw = await readStdin().catch(() => "");
const userCommand = process.argv[2] ? Buffer.from(process.argv[2], "base64").toString("utf8") : "";
const sd = process.env[CL_ENV.STATE_DIR];
const [code] = await Promise.all([
    userCommand ? runUserStatusLine(userCommand, raw) : Promise.resolve(0),
    sd ? relay(sd, raw) : Promise.resolve(),
]);
process.exit(code);
