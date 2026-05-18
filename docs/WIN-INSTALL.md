# aiball on Windows — install + run guide (#B.178)

> **Status**: scaffold. The PowerShell installer (`install.ps1`) covers
> the daemon + `aiball` CLI + `aiball-mcp`. `claude-loop` requires tmux
> and is left out of the Windows path for now (use WSL2 if you want
> the wrapper; the daemon + MCP + autopoll Stop hook are enough for
> 90% of usage).

## Prerequisites

Most prereqs install via `winget` (Windows 10 1809+ / Windows 11):

```powershell
winget install OpenJS.NodeJS.LTS    # node + npm
winget install Git.Git              # for cloning the repo
```

You'll also need:
- **PowerShell 7+** (`winget install Microsoft.PowerShell`) — the install
  script uses modern syntax. Windows PowerShell 5.1 may work but isn't
  exercised.
- A **terminal** that handles ANSI colors (Windows Terminal, recommended).

## Install

Clone the repo and run the installer:

```powershell
git clone https://github.com/quazardous/aiball.git
cd aiball
.\install.ps1
```

What it does (mirror of `install.sh`):
1. Runs `npm install` and builds the frontend (`npm run build` in `frontend/`).
2. Copies the repo to `%LOCALAPPDATA%\Programs\aiball\` (or symlinks if
   you pass `--symlink` and have Developer Mode on).
3. Creates `.cmd` shims in `%LOCALAPPDATA%\Microsoft\WindowsApps\` for
   `aiball`, `aiball-mcp` (already on `PATH` by default on modern Windows).
4. Registers a **per-user Scheduled Task** that auto-launches the daemon
   at login (`aiball-daemon`). View / control via Task Scheduler or:
   ```powershell
   Start-ScheduledTask -TaskName aiball-daemon
   Stop-ScheduledTask  -TaskName aiball-daemon
   Get-ScheduledTask   -TaskName aiball-daemon | Get-ScheduledTaskInfo
   ```
5. Prints the first-time setup URL (same as `install.sh --auth-init`).

## Daemon lifecycle

| | |
| --- | --- |
| Start  | `Start-ScheduledTask -TaskName aiball-daemon` |
| Stop   | `Stop-ScheduledTask -TaskName aiball-daemon` |
| Status | `Get-ScheduledTask -TaskName aiball-daemon \| Get-ScheduledTaskInfo` |
| Logs   | `%LOCALAPPDATA%\aiball\daemon.log` (rolled by the scheduled task) |
| Data   | `%APPDATA%\aiball\` (SQLite DB, uploads, spool) |
| Check  | `aiball check` |

## Transport: TCP, not UDS

The Unix domain socket the Linux daemon uses doesn't have a clean
counterpart on Windows that node's `net.createServer` can listen on
identically across all versions. The Windows daemon binds **TCP-only**
on `127.0.0.1:7777` with an auth-token authentication path (the same
fallback Linux uses for non-UDS callers). The first install mint a
token and stores it in `%APPDATA%\aiball\token` — `aiball` CLI and
`aiball-mcp` read it from there.

## What's NOT in the Windows path

- **`claude-loop`** — requires tmux. Use WSL2 + the Linux install if
  you want the tmux wrapper. The Windows daemon + the per-project
  `.mcp.json` + autopoll Stop hook gives you everything except the
  background-tmux-loop.
- **systemd**. The Scheduled Task replaces it. No socket-activation;
  the daemon launches at login and stays up until logout.

## Troubleshooting

- **`aiball: command not found` after install** → the `.cmd` shim dir
  isn't on PATH. Add `%LOCALAPPDATA%\Microsoft\WindowsApps` to your
  user PATH or re-run `install.ps1`, which checks + nudges.
- **Daemon won't start** → check `%LOCALAPPDATA%\aiball\daemon.log`.
  Common cause: port 7777 already in use. Pass `--port 7780` to
  `install.ps1` or set `AIBALL_PORT` env.
- **MCP can't reach daemon** → `.mcp.json` agents talk TCP on Windows.
  Make sure the daemon is running and `AIBALL_URL` matches the install
  port. Default `http://127.0.0.1:7777`.

## Roadmap (open ideas, not commitments)

- **NSSM service alternative** to the Scheduled Task for users who
  want service-manager semantics (auto-restart on crash).
- **Windows Terminal profile** auto-add for one-click `aiball check`
  shell.
- **claude-loop port via psmux** (#B.178). David's pick for the
  Windows multiplexer: <https://github.com/psmux/psmux>. The
  `claude-loop` adapter would need PowerShell equivalents for the
  6 tmux operations the wrapper uses (`new-session -d`, `send-keys`,
  `capture-pane`, `set-option`, `has-session`, `kill-session`).
  Once psmux exposes those, the port is a ~50-LOC change in
  `src/claude-loop/state.ts` (it already has a `MUX_CMD` env
  parameter for the multiplexer binary). Not committed yet —
  pending an API-surface check against psmux's actual command set.
