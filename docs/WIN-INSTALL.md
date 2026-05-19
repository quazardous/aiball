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
winget install OpenJS.NodeJS.LTS    # node + npm (any Node >=20 works)
winget install Git.Git              # for cloning the repo
```

You'll also need:
- **PowerShell 7+** (`winget install Microsoft.PowerShell`) — the install
  script uses modern syntax. Windows PowerShell 5.1 may work but isn't
  exercised.
- A **terminal** that handles ANSI colors (Windows Terminal, recommended).

Any Node >=20 works (`better-sqlite3` v12+ ships prebuilts for both
Node 22 and 24 — no compile step needed). The installer runs a sanity
check post-install that catches the rare case where a brand-new Node
major lands without prebuilts yet, and prints actionable recovery
steps.

## Install

Clone the repo and run the installer:

### Pick an install path

Five ways to run aiball on Windows, from "just try it" to "full integrated":

| # | Path | Daemon | Tray | UI | Effort |
|---|---|---|---|---|---|
| 1 | **Portable** (no install) | `npm run dev` in a terminal | manual `bin\aiball-tray.cmd` | vite dev http://localhost:5173 | dev/hacking |
| 2 | **Minimal** (`-Minimal`) | Scheduled Task pointing at this checkout | Desktop + Start Menu + Startup shortcuts | http://127.0.0.1:7777 | one command |
| 3 | **Default install** | Scheduled Task pointing at copy in `%LOCALAPPDATA%` | same as 2 | http://127.0.0.1:7777 | one command |
| 4 | **Service install** | NSSM Windows Service | same as 2 | http://127.0.0.1:7777 | one command (admin) |
| 5 | **Dev install** (`-Symlink`) | Scheduled Task on symlinked copy | same as 2 | http://127.0.0.1:7777 | one command (Dev Mode on) |

Same Death Star icon across 2/3/4/5 — consistent visible UX regardless of daemon mode. Path 1 needs no install at all.

### Path 1: Portable (no install)

```powershell
git clone https://github.com/quazardous/aiball.git
cd aiball
npm install
npm --prefix frontend install
# Terminal A — daemon
npm run dev
# Terminal B — vite dev server (HMR, http://localhost:5173)
npm --prefix frontend run dev
# Optional: tray icon in any other terminal
.\bin\aiball-tray.cmd
```

Nothing is registered, no shortcuts created, no data dir created in
your profile. Closing the terminals stops everything. Use this when
you're hacking on the code itself.

### Path 2: Minimal install (`-Minimal`)

```powershell
git clone https://github.com/quazardous/aiball.git
cd aiball
pwsh -File install.ps1 -Minimal -AuthInit
```

What it does (vs Path 3 default):
- ❌ No copy to `%LOCALAPPDATA%\Programs\aiball` — daemon runs from this checkout in place.
- ✅ `npm install` in this checkout (idempotent if already done).
- ✅ Scheduled Task registered, pointing at the checkout.
- ✅ CLI shims in `%LOCALAPPDATA%\Microsoft\WindowsApps` (so `aiball` / `aiball-mcp` / `claude-loop` work from any shell), all pointing at `$repo\bin\*.cmd`.
- ✅ Tray shortcuts (Desktop / Start Menu / Startup) — same Death Star icon as other paths.

Trade-off: if you move/delete the checkout, the daemon AND the shims
stop working — no Uninstall needed first, but the shims will error
out. Best fit for "I'm hacking on the code, just make it run".

Incompatible with `-Service` / `-System` / `-Symlink` (Minimal is
already in-place).

### Path 3: Default install (Scheduled Task)

```powershell
git clone https://github.com/quazardous/aiball.git
cd aiball
pwsh -File install.ps1             # daemon at logon, tray shortcuts auto-created
pwsh -File install.ps1 -AuthInit   # same but also starts the daemon + mints setup URL
```

What it does:
1. Verifies prereqs (`node >=20`, `npm`, `git`).
2. Copies the source tree to `%LOCALAPPDATA%\Programs\aiball\` via
   `robocopy /MIR` (or symlinks with `-Symlink` — see Path 5).
3. Runs `npm install` in the install dir. Dies loudly if it fails
   (daemon needs the deps). Builds the frontend bundle if missing;
   failures here only Warn (daemon still serves the API, no SPA).
4. Creates `%APPDATA%\aiball\` (DB + uploads) and
   `%LOCALAPPDATA%\aiball\` (logs + daemon launcher).
5. Writes `.cmd` shims in `%LOCALAPPDATA%\Microsoft\WindowsApps\` for
   `aiball`, `aiball-mcp`, `claude-loop` (already on `PATH` by default).
6. Writes **tray shortcuts** with the Death Star icon
   (`-NoTray` to skip):
   - `~\Desktop\aiball.lnk`
   - `~\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\aiball.lnk`
   - `~\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\aiball-tray.lnk`
     (auto-launches the tray at logon — Slack/Discord/Spotify convention)
7. Registers a **per-user Scheduled Task** `aiball-daemon` that auto-runs
   at logon (restart x5 every 1min on failure). View / control:
   ```powershell
   Start-ScheduledTask -TaskName aiball-daemon
   Stop-ScheduledTask  -TaskName aiball-daemon
   Get-ScheduledTask   -TaskName aiball-daemon | Get-ScheduledTaskInfo
   ```
8. **Sanity check**: actually constructs a `new Database(':memory:')`
   to flush out missing native bindings. If it fails, the task is
   **auto-disabled** so it doesn't restart-loop at logon. Recovery
   command is printed.
9. With `-AuthInit`: starts the task, waits up to 15s for `/api/health`,
   then runs `aiball auth init` and prints the setup URL.

### Path 4: Service install (Windows Service via NSSM)

```powershell
winget install NSSM.NSSM                       # prereq, one-time
# from an elevated (admin) PowerShell:
pwsh -File install.ps1 -Service                # current user (prompts password)
# OR:
pwsh -File install.ps1 -System                 # LocalSystem (no password)
```

See the **Service mode** section below for the per-user vs LocalSystem
trade-off and the password pitfall. Tray shortcuts identical to Path 3.

### Path 5: Dev install (symlink)

```powershell
# Enable Developer Mode first (Settings -> System -> For Developers),
# then:
pwsh -File install.ps1 -Symlink
```

Symlinks `%LOCALAPPDATA%\Programs\aiball` to your repo checkout, so
edits to `src/` and `frontend/src/` are picked up by a `Restart-Service
aiball-daemon` (or a vite dev server) without re-running the installer.

### Useful flags (all paths 3/4/5)

| Flag | What |
|---|---|
| `-Minimal` | in-place install (no copy, no shims), daemon points at this checkout |
| `-Service` | NSSM Windows Service instead of Scheduled Task (admin) |
| `-System` | implies `-Service`, runs as LocalSystem (admin) |
| `-Symlink` | symlink the install dir to this checkout (needs Dev Mode/admin) |
| `-Port 7780` | non-default daemon port |
| `-BindHost 0.0.0.0` | listen on all interfaces (use with care; default is localhost) |
| `-NoTray` | skip Desktop / Start Menu / Startup shortcut creation |
| `-AuthInit` | start daemon + mint setup token |
| `-Uninstall` | remove everything (keeps `%APPDATA%\aiball` data unless `-PurgeData`) |
| `-PurgeData` | with `-Uninstall`, also wipe the data dir |
| `-Yes` | skip interactive confirmations |

## Daemon lifecycle

Scheduled Task (default — no flag at install):

| | |
| --- | --- |
| Start  | `Start-ScheduledTask -TaskName aiball-daemon` |
| Stop   | `Stop-ScheduledTask -TaskName aiball-daemon` |
| Status | `Get-ScheduledTask -TaskName aiball-daemon \| Get-ScheduledTaskInfo` |
| Logs   | `%LOCALAPPDATA%\aiball\daemon.log` (rolled at 8MB by the launcher) |
| Data   | `%APPDATA%\aiball\` (SQLite DB, uploads, spool) |
| Check  | `aiball check` |

Windows Service (`-Service` or `-System` at install):

| | |
| --- | --- |
| Start  | `Start-Service -Name aiball-daemon` |
| Stop   | `Stop-Service -Name aiball-daemon` |
| Status | `Get-Service -Name aiball-daemon` (or `services.msc`) |
| Logs   | `%LOCALAPPDATA%\aiball\daemon.log` (`-Service`) or `%PROGRAMDATA%\aiball\logs\daemon.log` (`-System`) |
| Data   | `%APPDATA%\aiball\` (`-Service`) or `%PROGRAMDATA%\aiball\` (`-System`) |
| Check  | `aiball check` |

## Service mode

By default the daemon runs from a per-user Scheduled Task (zero admin, no
password, restart-x5 on failure). For most usage that's fine. Pick the
Service path if you want one of:

- Daemon up **at boot**, before any login.
- Daemon **survives logout**.
- Native `services.msc` visibility.
- LocalSystem-scoped DataDir (one daemon for the whole machine, multiple
  Windows accounts share it).

### Per-user service (`-Service`)

```powershell
winget install NSSM.NSSM                       # prereq, one-time
# from an elevated (admin) PowerShell — even per-user services need
# admin to register with the SCM:
pwsh -File install.ps1 -Service                # prompts for your Windows password
```

The password is stored encrypted in **LSA Secrets** by Windows (the same
store used for cached credentials and service accounts) — not in
plaintext on disk anywhere. Only the SCM reads it back to start the
service.

**Pitfall**: if you change your Windows password later, the service
**stops working** until you re-run `install.ps1 -Service` to re-set it.
There's no way around that for non-system accounts; it's the same gotcha
that affects any service running under a user account.

### LocalSystem service (`-System`)

```powershell
winget install NSSM.NSSM                     # prereq, one-time
# from an elevated (admin) PowerShell:
pwsh -File install.ps1 -System
```

No password, no per-user account, survives password changes. Trade-off:

- Data lives at `%PROGRAMDATA%\aiball\` (shared across users), not your
  `%APPDATA%\aiball\`.
- Requires admin to install (one-time).
- The daemon runs with full system privileges — fine because it's a
  local-only TCP listener, but worth knowing.

### Switching between modes

Re-running `install.ps1` (with or without `-Service`) automatically
removes the opposite registration, so you never end up with two daemons
fighting over port 7777. To go back to a Scheduled Task: just re-run
without `-Service`.

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
- **systemd**. A per-user Scheduled Task replaces it for the default
  path; an NSSM-managed Windows Service is also available via
  `-Service` / `-System` (see above). No socket-activation in either.
- **`aiball-tailscale`** — the bash helper that wraps `tailscale serve`
  (see [`docs/TAILSCALE.md`](TAILSCALE.md)) is Linux/macOS-only: it
  reads the daemon port from the systemd drop-in, which doesn't exist
  on Windows. To expose the Windows daemon over Tailscale today,
  configure `tailscale serve` manually pointing at
  `http://127.0.0.1:7777` — same security model, just no helper script.

## Troubleshooting

- **Install ends with `[aiball] install complete (degraded — daemon
  disabled)`** → the better-sqlite3 sanity check failed (no prebuilt
  binding for your Node major). The scheduled task was auto-disabled
  so it doesn't restart-loop at next logon. Three fixes, in order of
  effort:
  1. Bump `better-sqlite3` in `package.json` if a newer version has
     prebuilts for your Node major (`npm view better-sqlite3 versions`)
  2. Install **VS Build Tools** ("Desktop development with C++" workload)
     and `npm rebuild better-sqlite3 --build-from-source` in
     `%LOCALAPPDATA%\Programs\aiball`
  3. Pin Node to current LTS (`winget install OpenJS.NodeJS.LTS`)

  Then re-enable:
  ```powershell
  Enable-ScheduledTask -TaskName aiball-daemon
  Start-ScheduledTask  -TaskName aiball-daemon
  ```
- **`npm install failed in ... (exit 1)` during install** → almost
  always `node-gyp` falling back to source compilation without VS Build
  Tools. Same fixes as above (bump dep version, install VS Build Tools,
  or downgrade Node).
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
