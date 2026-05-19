# aiball on Windows — install + run guide (#B.178)

> **Status**: working. The PowerShell installer (`install.ps1`) provisions
> the daemon + `aiball` CLI + `aiball-mcp` end-to-end, with a per-user
> Scheduled Task auto-launching the daemon at logon. `claude-loop` ships
> its `.cmd` launcher but the wrapper still needs tmux — use WSL2 if you
> want the autonomous-loop feature. The daemon + MCP + autopoll Stop hook
> cover ~90% of daily usage.

## Prerequisites

Most prereqs install via `winget` (Windows 10 1809+ / Windows 11):

```powershell
winget install OpenJS.NodeJS.LTS    # node + npm — LTS, NOT latest (see below)
winget install Git.Git              # for cloning the repo
```

You'll also need:
- **PowerShell 7+** (`winget install Microsoft.PowerShell`) — the install
  script uses modern syntax. Windows PowerShell 5.1 may work but isn't
  exercised.
- A **terminal** that handles ANSI colors (Windows Terminal, recommended).

### Why Node LTS (22), not latest (24+)

`better-sqlite3` ships **prebuilt native bindings** only up to the current
LTS major (22 as of 2026-05). On Node 24+, `npm install` falls back to
compiling from source via `node-gyp`, which requires **VS Build Tools**
("Desktop development with C++" workload — a multi-GB install). Without
those tools, `npm install` dies with `find VS ... could not use PowerShell
to find Visual Studio 2017 or newer` and the daemon can't start.

The installer detects this case and warns at the top, then again with a
clear recovery message after `npm install` fails. If you want bleeding-edge
Node anyway, either install VS Build Tools or run `npm rebuild
better-sqlite3 --build-from-source` inside `%LOCALAPPDATA%\Programs\aiball`.

## Install

Clone the repo and run the installer:

```powershell
git clone https://github.com/quazardous/aiball.git
cd aiball
pwsh -File install.ps1               # fresh install (copy mode)
pwsh -File install.ps1 -Symlink      # dev install (needs Developer Mode)
pwsh -File install.ps1 -AuthInit     # also mint the first-time setup token
pwsh -File install.ps1 -Uninstall    # remove (keeps %APPDATA%\aiball data)
```

What it does (mirror of `install.sh`):
1. Verifies prereqs (`node >=20`, `npm`, `git`). Warns if Node `>=24` —
   see the Node LTS rationale above.
2. Copies the source tree to `%LOCALAPPDATA%\Programs\aiball\` via
   `robocopy /MIR` (or symlinks with `-Symlink` — requires Developer Mode
   or admin). Reentrant: existing symlink kept as dev layout unless
   `-Uninstall` first.
3. Runs `npm install` in the install dir. Dies loudly if it fails
   (the daemon can't start without deps). Builds the frontend bundle
   if `frontend/dist/index.html` is missing; failures here are downgraded
   to a warning (daemon still serves the API, just not the SPA).
4. Creates `%APPDATA%\aiball\` (DB + uploads) and `%LOCALAPPDATA%\aiball\`
   (logs + daemon launcher).
5. Writes `.cmd` shims in `%LOCALAPPDATA%\Microsoft\WindowsApps\` for
   `aiball`, `aiball-mcp`, `claude-loop` (already on `PATH` by default
   on modern Windows). Thin wrappers — no admin / Dev Mode needed.
6. Registers a **per-user Scheduled Task** `aiball-daemon` that auto-runs
   at logon (restart x5 every 1min on failure). View / control via Task
   Scheduler or:
   ```powershell
   Start-ScheduledTask -TaskName aiball-daemon
   Stop-ScheduledTask  -TaskName aiball-daemon
   Get-ScheduledTask   -TaskName aiball-daemon | Get-ScheduledTaskInfo
   ```
7. **Sanity check**: actually constructs a `new Database(':memory:')`
   to flush out missing native bindings (the JS module loads fine even
   when the `.node` binding is absent — only construction triggers the
   lookup). If it fails, the scheduled task is **auto-disabled** so it
   doesn't restart-loop at logon. Recovery command is printed.
8. With `-AuthInit`: starts the task, waits up to 15s for `/api/health`,
   then runs `aiball auth init` and prints the setup URL.

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

- **`claude-loop` wrapper** — the `claude-loop.cmd` launcher ships and
  `claude-loop --help` works, but the wrapper needs tmux to actually
  spawn anything. Use WSL2 if you want the autonomous-loop feature. The
  Windows daemon + per-project `.mcp.json` + autopoll Stop hook give you
  everything except the background loop.
- **systemd**. A per-user Scheduled Task replaces it. No socket-activation;
  the daemon launches at logon and stays up until logout.
- **Windows Service**. Not yet — a Scheduled Task is the v1 choice
  (lighter, no admin required, scoped to the logged-in user). NSSM
  service-manager support is on the roadmap if there's demand.

## Troubleshooting

- **Install ends with `[aiball] install complete (degraded — daemon
  disabled)`** → the better-sqlite3 sanity check failed. The scheduled
  task was auto-disabled so it doesn't restart-loop at next logon. Fix
  per the Node-LTS rationale above (downgrade to Node 22 or install VS
  Build Tools + `npm rebuild`), then:
  ```powershell
  Enable-ScheduledTask -TaskName aiball-daemon
  Start-ScheduledTask  -TaskName aiball-daemon
  ```
- **`npm install failed in ... (exit 1)` during install** → almost
  always `node-gyp` failing to find Visual Studio on Node 24+. Same fix
  as above.
- **Frontend `npm run build` fails with `received "../../.../index.html"`
  under `-Symlink`** → known vite-with-symlinks upstream issue.
  Workarounds: (a) run install in copy mode (no `-Symlink`), OR (b)
  build in the source tree first (`cd frontend && npm install && npm
  run build`) before re-running install with `-Symlink`. Either way the
  daemon still runs — only the SPA is unavailable (`/` returns 503).
- **`aiball: command not found` after install** → the shim dir isn't on
  PATH. Add `%LOCALAPPDATA%\Microsoft\WindowsApps` to your user PATH
  (it usually is by default on Windows 10 1809+).
- **Daemon won't start (when sanity check passed at install time)** →
  check `%LOCALAPPDATA%\aiball\daemon.log`. Common cause: port 7777
  already in use. Re-install with `-Port 7780` or set `AIBALL_PORT` env.
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
