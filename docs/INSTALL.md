# aiball on Linux / macOS — install + run guide

> **Status**: working on Linux (primary platform) and macOS (best-effort
> — same install path; the daemon, CLI, MCP server and `claude-loop`
> all run, but no launchd unit ships yet — start the daemon
> manually (`cd ~/.local/lib/aiball && npm start`) or via your own
> LaunchAgent). The shell installer
> (`install.sh`) provisions the daemon + `aiball` CLI + `aiball-mcp` +
> `claude-loop` end-to-end. The daemon listens on a Unix domain socket
> by default (`~/.local/share/aiball/sock`); for remote access see
> [`TAILSCALE.md`](./TAILSCALE.md) and [`REMOTE.md`](./REMOTE.md).
>
> Windows lives in its own guide — see [`WIN-INSTALL.md`](./WIN-INSTALL.md).

## Prerequisites

- **Node ≥ 20** (`node --version`). Any LTS works; `better-sqlite3` v12+
  ships prebuilts for Node 22 and 24 so there's no compile step.
  - Debian/Ubuntu: `sudo apt install nodejs npm` (or via `nvm`).
  - Fedora: `sudo dnf install nodejs npm`.
  - macOS: `brew install node`.
- **npm** (bundled with node).
- **rsync** (used by the hard-install path to deploy the source tree).
- **systemd** (Linux only, for the user-service path; skip with
  `--no-systemd` on macOS or hosts without a user session).
- **tmux** + **python3** for `claude-loop`. Python 3 enables the PTY
  proxy for live human-typing detection — see
  [`PTY-PROXY.md`](./PTY-PROXY.md). Both ship by default on most distros.
- **`websocket-client`** Python package — used by the PTY proxy for the
  ws-over-UDS IPC with the timer (view-push receive + proxy-events emit).
  Install with `pip install --user websocket-client` (or your
  distribution package, e.g. `dnf install python3-websocket-client` on
  Fedora). Replay-mode subtests don't need it.

## Install

Clone the repo and pick an install mode:

### Pick an install path

Three ways to run aiball on Linux/macOS, from "just try it" to "I'm
hacking on the source":

| # | Path | Code dir | Edits picked up | Daemon | Effort |
|---|---|---|---|---|---|
| 1 | **Portable** (no install) | this checkout | restart manually | `npm start` in a terminal | dev/hacking |
| 2 | **Hard install** (default) | rsync copy at `~/.local/lib/aiball` | only after re-running `./install.sh` | systemd user service | one command |
| 3 | **Dev install** (`--symlink`) | `~/.local/lib/aiball` → this checkout | live (tsx watch reloads the daemon, frontend needs `npm run build`) | systemd user service | one command |

The data dir (`~/.local/share/aiball` — DB, sock, tokens, uploads, logs)
is the **same** across all three modes and survives `--uninstall`.

### Path 1: Portable (no install)

```bash
git clone https://github.com/quazardous/aiball.git
cd aiball
npm install
npm --prefix frontend install
npm --prefix frontend run build     # builds dist/ once
npm start                            # foreground daemon
```

Nothing is registered, no symlinks created, no systemd unit. Closing the
terminal stops the daemon. CLIs (`aiball`, `aiball-mcp`, `claude-loop`)
must be invoked via `./bin/aiball …` from the repo root, or you add
`./bin/` to your `PATH` manually. Use this when you're hacking on the
code and don't want install-side-effects.

### Path 2: Hard install (default)

```bash
git clone https://github.com/quazardous/aiball.git
cd aiball
./install.sh    # also mints a one-shot setup token + prints the setup URL
```

What it does:

1. Verifies prereqs (`node ≥ 20`, `npm`, `rsync`).
2. Builds the frontend bundle if missing (`frontend/dist/index.html`),
   then `rsync`s the source tree to `~/.local/lib/aiball/` (excluding
   `node_modules`, `.git`, `*.log`, `.env`, `var/`).
3. Runs `npm install` in the install dir (tsx is in devDependencies
   but needed at runtime, so we install everything).
4. Symlinks the CLIs into `~/.local/bin/`:
   `aiball`, `aiball-mcp`, `claude-loop`.
5. Installs the systemd user unit (`~/.config/systemd/user/aiball.service`),
   enables it, and (re)starts it. Skip with `--no-systemd`.
6. Auth bootstrap (reentrant — skipped if humans already exist): waits
   for `/api/health`, then runs `aiball auth init` and prints the setup
   URL. Re-mint later with `aiball auth reinit`.

After install, the daemon is live and you can iterate with:

```bash
aiball check        # health probe (config + consumer + daemon + deps)
aiball --version
systemctl --user status aiball
```

#### Install a specific stable release

`git clone` above tracks `main` (the latest development state). To install a
tagged **stable release** instead, pin the checkout to the release tag before
running `install.sh` — everything else is identical:

```bash
git clone https://github.com/quazardous/aiball.git
cd aiball
git checkout v0.37.0     # a tag from the releases page
./install.sh
```

Or without git, from the release's source tarball:

```bash
curl -fsSL https://github.com/quazardous/aiball/archive/refs/tags/v0.37.0.tar.gz | tar xz
cd aiball-0.37.0
./install.sh
```

Releases (tags + notes) are on the [releases page](https://github.com/quazardous/aiball/releases);
`aiball --version` then reports the installed tag. Releases ship **source only**
(no pre-built binaries — the Rust PTY proxy is built at install time via `cargo`,
best-effort). To move an existing install to a newer release, re-checkout the new
tag (or re-extract) and re-run `./install.sh`.

### Path 3: Dev install (`--symlink`)

```bash
git clone https://github.com/quazardous/aiball.git
cd aiball
./install.sh --symlink
```

Same as Path 2, with two differences:

- `~/.local/lib/aiball` is a **symlink** to this checkout (instead of a
  rsync copy). Edits to `src/` and the daemon source tree are immediate;
  no re-install needed.
- A systemd drop-in (`~/.config/systemd/user/aiball.service.d/dev.conf`)
  switches the daemon to **tsx watch mode** — saved `.ts` files trigger
  an auto-restart. Removed automatically if you later re-run without
  `--symlink`.

The frontend SPA is **not** auto-rebuilt by tsx watch — `vue-tsc` only
typechecks, it doesn't emit. After editing anything under `frontend/src/`,
rebuild the bundle and hard-reload the browser:

```bash
cd frontend && npm run build
```

DB migrations only run at daemon **boot** — applying a fresh migration
under tsx watch needs a hard restart (`aiball restart` →
`systemctl --user restart aiball`); see [`MIGRATIONS.md`](./MIGRATIONS.md).

**Re-running `./install.sh` preserves the existing layout.** If
`~/.local/lib/aiball` is already a symlink, the installer keeps the dev
layout (no silent flip to a rsync copy). To switch back to the hard
install, run `./install.sh --uninstall` first.

### Useful flags

| Flag | What |
|---|---|
| `--symlink` | dev install — symlink the install dir to this checkout + tsx-watch drop-in |
| `--port 7878` | override the listen port (writes a systemd drop-in; default `7777`) |
| `--host 0.0.0.0` | override the listen host (default `127.0.0.1`; use with care) |
| `--no-systemd` | skip the user unit (macOS, headless boxes — start the daemon manually, see below) |
| `--proxy-url URL` | proxy-node mode — run this daemon as a transparent relay to a remote aiball (see [`REMOTE.md`](./REMOTE.md)) |
| `--proxy-token TOK` | with `--proxy-url`, the node token minted on the remote (`aiball auth issue --node`) |
| `--uninstall` | remove the install (code, bins, systemd unit); data dir preserved |

Re-running with new `--port` / `--host` overwrites only the bind drop-in.
Existing data, tokens and accounts are preserved.

## Daemon lifecycle

systemd user service (default — install without `--no-systemd`):

| | |
| --- | --- |
| Start  | `systemctl --user start aiball` |
| Stop   | `systemctl --user stop aiball` |
| Restart (hard, re-runs migrations) | `aiball restart` *or* `kill -HUP $(cat ~/.local/share/aiball/daemon.pid)` |
| Reload (soft, config-only)         | `aiball reload`  *or* `kill -USR2 $(cat ~/.local/share/aiball/daemon.pid)` |
| Status | `systemctl --user status aiball` |
| Logs   | `journalctl --user -u aiball -f` |
| Data   | `~/.local/share/aiball/` (SQLite DB, sock, uploads, spool, tokens) |
| Check  | `aiball check` |

The pidfile (`~/.local/share/aiball/daemon.pid`) is the safe target for
signals: under tsx-watch the daemon's pid changes on every reload, so
the systemd MainPID may be stale within a single reload window.

`aiball restart` is the **hard restart**: it re-runs DB migrations,
reloads all code + env, and rebinds the socket. `aiball reload` is the
soft path: it triggers an in-place config reload with no downtime —
useful when most config is already read fresh per request and you only
need to revalidate boot-cached entries.

No `--no-systemd` daemon? Start it manually:

```bash
cd ~/.local/lib/aiball && npm start   # foreground
```

## Environment variables

The CLI and MCP read these at every invocation. Defaults are sensible
for a single-user laptop install:

| Variable | Default | Purpose |
|---|---|---|
| `AIBALL_HOME` | `~/.local/share/aiball` | Data dir (DB, sock, uploads, tokens). Override to relocate. |
| `AIBALL_SOCK` | `$AIBALL_HOME/sock` | Unix domain socket path. Override when running multiple daemons. |
| `AIBALL_HOST` | `127.0.0.1` | TCP bind host (`--host` writes a drop-in setting this). |
| `AIBALL_PORT` | `7777` | TCP bind port (`--port` writes a drop-in setting this). |
| `AIBALL_URL`  | derived | Full daemon URL (`http://$AIBALL_HOST:$AIBALL_PORT`). Override to point at a remote daemon. |
| `AIBALL_TOKEN` | — | Bearer token for TCP / remote access; ignored on the local UDS path. Stored in `$AIBALL_HOME/cli-env` after `aiball auth init`. |
| `AIBALL_CWD` | `$PWD` of the CLI invoker | Lets `aiball` / `claude-loop` resolve project-relative paths (`.mcp.json`, `.aiball.yaml`) from the **caller's** cwd, even when the binary `cd`s into its install dir before exec. Set by the `bin/` wrappers; rarely set manually. |
| `AIBALL_PROJECT` | — | Default project name for MCP `ticket_*` calls. Usually written into `.mcp.json` by `claude-loop init`. |

`$AIBALL_HOME/cli-env` is sourced by the `bin/` wrappers on every
invocation, so editing it (e.g. setting `export AIBALL_TOKEN=…`) is
enough — no shell restart needed.

## Layout post-install

```
~/.local/lib/aiball/             # code dir (rsync copy OR symlink to checkout)
├── bin/{aiball,aiball-mcp,claude-loop}
├── src/                          # daemon + CLI source (tsx, no build step)
├── frontend/dist/                # SPA bundle (rebuilt manually after edits)
└── ...

~/.local/bin/                     # CLI shims (on PATH)
├── aiball -> ~/.local/lib/aiball/bin/aiball
├── aiball-mcp -> ~/.local/lib/aiball/bin/aiball-mcp
└── claude-loop -> ~/.local/lib/aiball/bin/claude-loop

~/.local/share/aiball/            # $AIBALL_HOME (data, preserved by --uninstall)
├── aiball.db                     # SQLite
├── sock                          # Unix domain socket (default transport)
├── daemon.pid                    # current daemon pid (signal target)
├── cli-env                       # sourced by the bin/ wrappers
├── uploads/                      # content-addressable image store
└── spool/                        # offline ticket spool (drained on next daemon start)

~/.config/systemd/user/
├── aiball.service                # the unit
└── aiball.service.d/
    ├── dev.conf                  # tsx watch drop-in (--symlink only)
    └── bind.conf                 # host/port overrides (--host / --port only)
```

## Sanity-checks

```bash
aiball --version                       # version baked into package.json
aiball check                           # config + consumer + daemon + deps probe
systemctl --user status aiball          # unit health
readlink -f ~/.local/lib/aiball         # symlink target (Path 3) or real dir (Path 2)
ls -l ~/.local/share/aiball/sock        # socket present + writable
curl --unix-socket ~/.local/share/aiball/sock http://_/api/health
```

`aiball check` shows the resolved `.aiball.yaml`, the consumer
identity, the daemon reachability, and the python3 PTY-proxy
availability. It does **not** introspect the install layout (symlink vs
hard) — use `readlink -f` for that.

## What's NOT in the Linux path

- **macOS launchd unit**. The installer skips it (no `launchctl`
  template ships). Run with `--no-systemd` and start the daemon
  manually (`npm start`) or wrap it in your own LaunchAgent.
- **Frontend HMR auto-wired**. The hard install ships the prebuilt SPA;
  the dev install (`--symlink`) shares the checkout's `frontend/dist/`
  and the daemon serves that bundle — no vite dev server runs by
  default. If you want HMR, run `npm --prefix frontend run dev` in a
  side terminal.

## Uninstall

```bash
./install.sh --uninstall
```

Removes the systemd unit + drop-ins, the CLI symlinks in `~/.local/bin/`,
and the code dir at `~/.local/lib/aiball` (drops the symlink without
touching its target on Path 3 installs). The autopoll Stop hook is
surgically removed from `~/.claude/settings.json` and project-local
`./.claude/settings.json` (other hooks are preserved). The data dir
(`$AIBALL_HOME` = `~/.local/share/aiball`) is **preserved** — wipe it
manually if you want a clean slate.

## Troubleshooting

- **`aiball: command not found` after install** → `~/.local/bin` isn't
  on PATH. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc
  and start a fresh shell.
- **Daemon won't start (`systemctl --user status aiball` shows red)** →
  `journalctl --user -u aiball -n 100` for the last 100 lines. Common
  causes: port 7777 already in use (re-install with `--port 7878`), or
  a migration failure (apply migrations before deploying code that
  reads new columns — see [`MIGRATIONS.md`](./MIGRATIONS.md)).
- **`./install.sh` flipped my dev symlink to a rsync copy** → it
  shouldn't: the installer auto-detects an existing symlink and keeps
  the dev layout unless you explicitly `--uninstall` first. If it did,
  re-run with `--symlink` to restore the dev install.
- **Edits to `frontend/src/` don't show up** → `vue-tsc` / `tsx` only
  typecheck; they don't emit `dist/`. Run `cd frontend && npm run build`
  + hard-reload the browser (Ctrl+Shift+R).
- **New DB column / table not visible at runtime** → migrations only
  run at daemon boot. Hard restart with `aiball restart` (or
  `systemctl --user restart aiball`). A tsx-watch reload alone does
  NOT re-run migrations.
- **MCP can't reach the daemon** → check the socket path matches: the
  `bin/` wrappers default to `$AIBALL_HOME/sock`. If you set
  `AIBALL_HOME` to a custom location, propagate it to whatever process
  spawns the MCP server. For TCP / remote access, see
  [`REMOTE.md`](./REMOTE.md).
- **Switching from `--symlink` back to a hard install** → `./install.sh
  --uninstall` first (drops the symlink), then `./install.sh` (rsync
  copy). Data is preserved across the cycle.

## See also

- [`WORKFLOW.md`](./WORKFLOW.md) — branch vs main editing on the dev
  checkout (the dev install **is** the live runtime).
- [`CLAUDE-LOOP.md`](./CLAUDE-LOOP.md) — the tmux wrapper that turns a
  Claude Code session into a persistent agent.
- [`REMOTE.md`](./REMOTE.md) — run a local `claude-loop` against a
  remote aiball daemon over HTTP+token (no local install needed on the
  remote host).
- [`TAILSCALE.md`](./TAILSCALE.md) — expose the daemon over a tailnet
  for phone access.
- [`MIGRATIONS.md`](./MIGRATIONS.md) — SQLite migration conventions
  (apply BEFORE the code that depends on them).
