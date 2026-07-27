/**
 * Resolving `bash` on Windows — one answer, shared by every spawn site.
 *
 * `spawn("bash", …)` goes through PATH, and on Windows PATH is not a reliable
 * way to reach Git Bash. A machine with WSL installed carries at least two
 * other `bash.exe`:
 *
 *   C:\Program Files\Git\bin\bash.exe                       ← the one we want
 *   C:\Windows\System32\bash.exe                            ← the WSL launcher
 *   %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe           ← the Store WSL stub
 *
 * Whichever comes first depends on how the caller was launched, so the same
 * command works from Git Bash and fails from PowerShell. When WSL wins, it
 * opens a console, fails to `source` a Windows path that does not exist inside
 * its filesystem namespace, and dies. Worse, its output does not reach the
 * inherited file descriptor, so the failure leaves an EMPTY log — the loop just
 * never starts and nothing says why.
 *
 * This lived inline in `cli.ts` and covered only the psmux `new-session` that
 * launches claude; the two spawns that start the kernel (`claude-loop start`
 * and the kernel's own respawn) still called a bare `bash` and inherited the
 * bug. Hence a module: the next spawn site imports the answer instead of
 * rediscovering the trap.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Convert a Windows path to its 8.3 short form (no spaces).
 *
 * psmux splits the command at spaces when it rebuilds the CreateProcess
 * command line, so `C:\Program Files\Git\bin\bash.exe` gets truncated to
 * `C:\Program`. The 8.3 name (`C:\PROGRA~1\Git\bin\bash.exe`) sidesteps that.
 * No-op on non-Windows or for paths that already lack spaces. Falls back to
 * the input when conversion fails (8.3 generation disabled on the volume, …).
 */
export function toShortPathWin(p: string): string {
    if (process.platform !== "win32" || !p.includes(" ")) return p;
    try {
        // `windowsVerbatimArguments` matters and is not decoration: without it
        // Node applies its own Windows argument escaping, cmd.exe's `for` then
        // re-parses the added quotes, and the command returns
        // `C:\"C:\Program Files\…"` — which fails the existsSync below, so the
        // function quietly handed back the SPACED path it was asked to remove.
        // That silent fallback is why a resolved bash could still arrive at
        // psmux with a space in it (#1584).
        const out = spawnSync("cmd.exe", ["/c", `for %I in ("${p}") do @echo %~sI`], {
            encoding: "utf8",
            windowsVerbatimArguments: true,
        });
        const short = (out.stdout ?? "").trim();
        if (short && existsSync(short)) return short;
    } catch { /* fall through to raw path */ }
    return p;
}

/** Git for Windows install layouts, most canonical first. */
const GIT_BASH_CANDIDATES = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/**
 * The command to hand `spawn`/psmux for a bash shell.
 *
 * On Windows: the absolute path to Git Bash, in 8.3 form so a caller that
 * re-parses the command line at spaces (psmux) still sees one argument. On
 * anything else, and on a Windows box with no Git Bash found, plain `"bash"` —
 * there the PATH is either trustworthy or the only thing we have.
 */
export function resolveBashCmd(): string {
    if (process.platform !== "win32") return "bash";
    const found = GIT_BASH_CANDIDATES.find((p) => existsSync(p));
    return found ? toShortPathWin(found) : "bash";
}
