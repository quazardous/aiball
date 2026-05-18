#!/usr/bin/env -S npx --no-install tsx
/**
 * claude-loop timer process (#B.63 TS port). Detached child of the
 * `start` command. Polls every CL_INTERVAL seconds; when claude is
 * idle (idle-since marker present), picks a random phrase from the
 * loop's pings YAML and `tmux send-keys` it into pane 0. Claude
 * decides via its own context (MCP tools, etc) whether there's work
 * to do — david: "il faut immédiatement ping claude c'est tout".
 *
 * Logs to stdout (the launcher redirects to $STATE_DIR/timer.log).
 * Exits when the tmux session disappears.
 */
import { existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AiballClient } from "../client.js";
import {
    MUX_CMD,
    idleMarkerPath,
    pickPingPhrase,
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
    return pickPingPhrase(pingsPath(sd!));
}

function sendKeys(phrase: string): void {
    spawnSync(MUX_CMD, ["send-keys", "-t", `${tname}.0`, phrase, "Enter"], { stdio: "ignore" });
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// Cached client for the default-path direct API call (no fork). The
// process is long-lived so the keep-alive socket / token resolution
// stays warm across ticks. David #B.63: "claude-loop peut avoir un
// accès direct à l'api même niveau de aiball — on peut garder le
// check-cmd". When the user passes a custom --check-cmd, we still
// shell out so any external check works; only the default takes the
// fast in-process path.
const DEFAULT_AIBALL_CHECK = "aiball pings-count -q";
let aiballClient: AiballClient | null = null;
async function checkHasWork(): Promise<boolean> {
    // Empty / `true` check-cmd → always ping (legacy "pure timer").
    if (!checkCmd || checkCmd === "true") return true;
    // Default check-cmd → bypass subprocess fork, call the API directly.
    if (checkCmd === DEFAULT_AIBALL_CHECK) {
        if (!aiballClient) aiballClient = new AiballClient();
        try {
            const r = await aiballClient.pingsCount() as { unread?: number };
            return (r.unread ?? 0) > 0;
        } catch {
            return false;
        }
    }
    // Custom check-cmd → shell out so any user snippet works.
    const r = spawnSync("bash", ["-c", checkCmd], { stdio: "ignore" });
    return r.status === 0;
}

async function main(): Promise<void> {
    log(`timer started — tick every ${interval}s, check-cmd: ${checkCmd}`);
    while (tmuxAlive()) {
        await sleep(interval * 1000);
        if (!existsSync(idleMarkerPath(sd!))) continue;
        // Manual wake (claude-loop wake NAME) bypasses the check —
        // user explicitly asked to fire the next tick.
        const manualWake = existsSync(wakeRequestedPath(sd!));
        if (!manualWake && !(await checkHasWork())) continue;
        try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
        try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
        const phrase = pickPhrase();
        sendKeys(phrase);
        log(`wake (${manualWake ? "manual" : "check-cmd hit"}) → '${phrase}'`);
    }
    log("tmux session gone — timer exiting");
}

main().catch((e) => {
    process.stderr.write(`[claude-loop:${name}] timer crashed: ${String(e)}\n`);
    process.exit(1);
});
