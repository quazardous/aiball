#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop timer process (#B.63 TS port). Detached child of the
 * `start` command. Polls every CL_INTERVAL seconds; when claude is
 * idle (idle-since marker present) AND either a manual wake was
 * requested OR the check-cmd reports work (exit 0), picks a random
 * phrase from the loop's pings YAML and `tmux send-keys` it into
 * pane 0 of the loop's tmux session.
 *
 * Logs to stdout (the launcher redirects to $STATE_DIR/timer.log).
 * Exits when the tmux session disappears.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
    MUX_CMD,
    idleMarkerPath,
    pingsPath,
    tmuxName,
    wakeRequestedPath,
} from "./state.js";

const sd = process.env.CL_STATE_DIR;
const name = process.env.CL_NAME;
const intervalRaw = process.env.CL_INTERVAL;
const checkCmd = process.env.CL_CHECK_CMD ?? "true";
if (!sd || !name || !intervalRaw) {
    process.stderr.write("[claude-loop:timer] missing CL_* env vars\n");
    process.exit(1);
}
const interval = Math.max(1, Number(intervalRaw));
const tname = tmuxName(name);

function log(msg: string): void {
    process.stdout.write(`[claude-loop:${name}] ${msg}\n`);
}

function tmuxAlive(): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tname], { stdio: "ignore" });
    return r.status === 0;
}

function pickPhrase(): string {
    try {
        const raw = readFileSync(pingsPath(sd!), "utf8");
        const parsed = parseYaml(raw) as { ping_messages?: unknown };
        const list = Array.isArray(parsed?.ping_messages)
            ? (parsed.ping_messages as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        if (list.length === 0) return "ping";
        return list[Math.floor(Math.random() * list.length)];
    } catch {
        return "ping";
    }
}

function sendKeys(phrase: string): void {
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, phrase, "Enter"], { stdio: "ignore" });
}

function runCheckCmd(): boolean {
    const r = spawnSync("bash", ["-c", checkCmd], { stdio: "ignore" });
    return r.status === 0;
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

async function main(): Promise<void> {
    log(`timer started — poll every ${interval}s; check: ${checkCmd}`);
    while (tmuxAlive()) {
        await sleep(interval * 1000);
        if (!existsSync(idleMarkerPath(sd!))) continue;
        // Manual wake bypasses the check-cmd.
        if (existsSync(wakeRequestedPath(sd!))) {
            try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
            try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
            const phrase = pickPhrase();
            sendKeys(phrase);
            log(`manual wake → '${phrase}'`);
            continue;
        }
        if (runCheckCmd()) {
            try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
            const phrase = pickPhrase();
            sendKeys(phrase);
            log(`check-cmd hit → '${phrase}'`);
        }
    }
    log("tmux session gone — timer exiting");
}

main().catch((e) => {
    process.stderr.write(`[claude-loop:${name}] timer crashed: ${String(e)}\n`);
    process.exit(1);
});
