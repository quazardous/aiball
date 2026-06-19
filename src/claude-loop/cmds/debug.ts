/**
 * #1032 — `claude-loop debug <action> [name]` : fault injection to TEST the
 * reload/resync chantier (red bar #1039, proxy re-handshake / busy-latch resync
 * #1035, revive #1042) without hunting PIDs by hand.
 *
 * Every action LOGS (david : « qui log ») into the central loop NDJSON — it
 * reuses `createLogger` (the sole NDJSON owner, src/log.ts) + the existing
 * `LOG` frame transport over `loop.sock`, exactly like the hooks do. The line
 * is delivered to the kernel BEFORE the destructive action so the timeline reads
 *
 * Naming (#1036) : "kernel" = the long-lived worker process (loop.ts) ; "timer"
 * is reserved for genuine setTimeout/setInterval. "proxy" = pty-proxy.py.
 * `debug kill-proxy` → `proxy link lost` → `bar RED` in order.
 */
import { existsSync, readFileSync } from "node:fs";
import {
    stateDirFor,
    proxyAlivePath,
    loopPidPath,
    loopSockPath,
    LOOP_SOCK_KIND,
} from "../state.js";
import { sendEventOnce } from "../ipc-events.js";
import { createLogger } from "../../log.js";

const ACTIONS = ["kill-proxy", "kill-kernel"] as const;
type DebugAction = (typeof ACTIONS)[number];

function readPid(path: string): number | null {
    if (!existsSync(path)) return null;
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
}

export async function cmdDebug(action: string, name: string): Promise<void> {
    if (!ACTIONS.includes(action as DebugAction)) {
        process.stderr.write(`debug: unknown action '${action}'. Known: ${ACTIONS.join(", ")}\n`);
        process.exitCode = 1;
        return;
    }
    const sd = stateDirFor(name);

    // Reuse createLogger (NDJSON owner) + the LOG-frame transport (same path as
    // the hooks) so the entry lands in the central loop.log. We await the send
    // so the line is delivered before we kill (the CLI process is short-lived).
    let lastSend: Promise<unknown> = Promise.resolve();
    const logger = createLogger({
        tag: `debug:${name}`,
        write: (line: string) => {
            lastSend = sendEventOnce(
                loopSockPath(sd),
                { kind: LOOP_SOCK_KIND.LOG, data: { line } },
                { timeoutMs: 500, throwOnError: false },
            ).catch(() => { /* timer down — best-effort */ });
        },
    });

    const target = action === "kill-proxy"
        ? { pid: readPid(proxyAlivePath(sd)), label: "proxy", what: "pty-proxy.py" }
        : { pid: readPid(loopPidPath(sd)), label: "kernel", what: "loop.ts" };

    if (target.pid === null) {
        process.stderr.write(`debug ${action}: no ${target.label} pid for '${name}' (not running?)\n`);
        process.exitCode = 1;
        return;
    }

    logger.warning(`${action}: SIGKILL ${target.label} (${target.what}) pid ${target.pid} — fault injection (test)`);
    await lastSend; // ensure the line reached the timer before the kill

    try {
        process.kill(target.pid, "SIGKILL");
    } catch (e) {
        process.stderr.write(`debug ${action}: kill ${target.pid} failed: ${(e as Error).message}\n`);
        process.exitCode = 1;
        return;
    }

    if (action === "kill-proxy") {
        process.stdout.write(
            `debug kill-proxy: killed proxy pid ${target.pid} for '${name}'.\n`
            + `  → expect: bar goes RED after the ~10s grace, then the proxy reconnects (hello) → link OK + resync (#1035).\n`,
        );
    } else {
        process.stdout.write(
            `debug kill-kernel: killed kernel pid ${target.pid} for '${name}'.\n`
            + `  → expect: bar FREEZES (no painter left). Recover with \`claude-loop reload ${name}\` (or health --revive when it lands, #1042).\n`,
        );
    }
}
