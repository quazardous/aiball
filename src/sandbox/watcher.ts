/**
 * Daemon-side cron that re-arms dead sandbox loops when their agent
 * receives new pings (#B.81 point 2).
 *
 * For each `$AIBALL_HOME/.aiball-sandbox/<name>/plate.json`:
 *   - skip if not a loop (plain mux tests don't auto-respawn).
 *   - skip if halted (.halt === true is the user's "stop please").
 *   - skip if the tmux session is still alive — the running claude
 *     will see new pings on its own iteration.
 *   - else check `unreadPingCount(plate.agent)`. If > 0, the loop has
 *     work to do and we shell out to `aiball sandbox respawn <name>`.
 *
 * A throttle (`watcher.json`) prevents respawning the same dead
 * sandbox more than once per RESPAWN_THROTTLE_MS, which would burn
 * Claude turns if the agent doesn't ack the pings (it should, via
 * `mcp__aiball__unread --pings --mark-read`, but bugs happen).
 *
 * Errors never bubble: the cron tick logs and moves on so a single
 * malformed state dir doesn't take down the rest.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    STATE_ROOT,
    readPlate,
    platePath,
    stateDirFor,
    type Plate,
} from "./state.js";
import { unreadPingCount } from "../db.js";

const RESPAWN_THROTTLE_MS = 60_000;

interface WatcherState {
    last_respawn_at: string | null;
}

function watcherStatePath(sd: string): string {
    return join(sd, "watcher.json");
}

function readWatcherState(sd: string): WatcherState {
    const p = watcherStatePath(sd);
    if (!existsSync(p)) return { last_respawn_at: null };
    try {
        return JSON.parse(readFileSync(p, "utf8")) as WatcherState;
    } catch {
        return { last_respawn_at: null };
    }
}

function writeWatcherState(sd: string, state: WatcherState): void {
    const p = watcherStatePath(sd);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, p);
}

function tmuxHasSession(name: string): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return r.status === 0;
}

/**
 * Find the absolute path to bin/aiball. The daemon runs from the
 * install dir (~/.local/lib/aiball in production, or the dev checkout
 * via the symlinked drop-in), so we can derive it from import.meta.url.
 */
function aiballBinPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // <ROOT>/src/sandbox/ → up two = <ROOT>.
    return resolve(here, "..", "..", "bin", "aiball");
}

function respawn(name: string): { ok: boolean; stderr: string } {
    const r = spawnSync(aiballBinPath(), ["sandbox", "respawn", name], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
    });
    return {
        ok: r.status === 0,
        stderr: (r.stderr ?? "").toString(),
    };
}

export function checkSandboxPings(): void {
    try {
        if (!existsSync(STATE_ROOT)) return;
        for (const name of readdirSync(STATE_ROOT)) {
            const sd = stateDirFor(name);
            if (!existsSync(platePath(sd))) continue;
            let plate: Plate;
            try {
                plate = readPlate(sd);
            } catch {
                continue;
            }
            if (plate.kind && plate.kind !== "loop") continue;
            if (plate.halt === true) continue;

            // tmux alive → running claude will pick up new pings itself.
            if (tmuxHasSession(`sb-${name}`)) continue;

            const pings = unreadPingCount(plate.agent);
            if (pings === 0) continue;

            const ws = readWatcherState(sd);
            if (ws.last_respawn_at) {
                const dt = Date.now() - Date.parse(ws.last_respawn_at);
                if (Number.isFinite(dt) && dt >= 0 && dt < RESPAWN_THROTTLE_MS) {
                    continue;
                }
            }

            console.log(
                `[sandbox-watcher] respawn ${name} (${pings} unread pings for ${plate.agent})`,
            );
            const r = respawn(name);
            // Update the throttle even on failure to avoid hammering a
            // broken sandbox at every tick — the human can intervene.
            writeWatcherState(sd, { last_respawn_at: new Date().toISOString() });
            if (!r.ok) {
                console.error(
                    `[sandbox-watcher] respawn ${name} failed: ${r.stderr.trim()}`,
                );
            }
        }
    } catch (e) {
        console.error("[sandbox-watcher] tick failed:", e);
    }
}
