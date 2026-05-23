/**
 * Shared "is this command on PATH?" probe. Single source of truth for the
 * doctor checks (`aiball check`, `claude-loop check`) and the claude-loop
 * PTY-proxy launch (#269) so the check reports exactly what the launch
 * will decide. `stdio:"ignore"` keeps the probe quiet.
 *
 * `command -v` is a POSIX shell builtin (claude-loop is posix-centric —
 * tmux), but it does NOT exist in cmd.exe, so on Windows it returned false
 * for EVERYTHING — even `node`. Harmless today (the only Windows callers are
 * gated behind `process.platform` / X11 env that's unset on Windows), but a
 * footgun for any future caller. Use the OS lookup tool per platform:
 * `where` on Windows, `command -v` elsewhere — matching `need()` in
 * claude-loop's cli.ts.
 */
import { spawnSync } from "node:child_process";

export function commandExists(cmd: string): boolean {
    if (process.platform === "win32") {
        return spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;
    }
    return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}
