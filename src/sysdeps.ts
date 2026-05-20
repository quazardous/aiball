/**
 * Shared "is this command on PATH?" probe. Single source of truth for the
 * doctor checks (`aiball check`, `claude-loop check`) and the claude-loop
 * PTY-proxy launch (#269) so the check reports exactly what the launch
 * will decide. `command -v` is a POSIX shell builtin (claude-loop is
 * posix-centric — tmux); `stdio:"ignore"` keeps the probe quiet.
 */
import { spawnSync } from "node:child_process";

export function commandExists(cmd: string): boolean {
    return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}
