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

async function main(): Promise<void> {
    log(`timer started — tick every ${interval}s`);
    while (tmuxAlive()) {
        await sleep(interval * 1000);
        if (!existsSync(idleMarkerPath(sd!))) continue;
        // Whether the wake came from the periodic tick or from
        // `claude-loop wake NAME`, treat it identically — claude is
        // idle, send a phrase. The wake-requested marker is cleared
        // for housekeeping; behavior unchanged either way.
        try { unlinkSync(wakeRequestedPath(sd!)); } catch { /* race */ }
        try { unlinkSync(idleMarkerPath(sd!)); } catch { /* race */ }
        const phrase = pickPhrase();
        sendKeys(phrase);
        log(`wake → '${phrase}'`);
    }
    log("tmux session gone — timer exiting");
}

main().catch((e) => {
    process.stderr.write(`[claude-loop:${name}] timer crashed: ${String(e)}\n`);
    process.exit(1);
});
