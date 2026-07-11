# aiball — agent guide

aiball is a local-first, event-driven board that turns Claude Code
sessions into persistent, remotely-pilotable agents (one per project).
Daemon (Express + SQLite/Drizzle) + Vue frontend + the `claude-loop`
tmux wrapper + a stdio MCP server. See [`README.md`](./README.md).

## Start here

**Before doing anything on this codebase, read
[`CONTRIBUTING.md`](./CONTRIBUTING.md).** It owns the conventions —
code style, multi-agent norms, doc style, and the agent kit (what to
preload vs what to look up vs what to remember). This file (CLAUDE.md)
stays focused on operational truth: how the checkout runs, how to
restart, what the daemon expects.

## How this checkout runs (read before editing)

- **The dev checkout IS the live runtime.** `~/.local/lib/aiball` symlinks
  here; the daemon + `claude-loop` run the source via `tsx` (no build step).
- **Frontend edits need a rebuild**: `cd frontend && npm run build` —
  `tsx`/`vue-tsc` only typecheck, they don't emit `dist/` (which the daemon
  serves). Hard-reload the browser after.
- **DB migrations only run at daemon boot.** A `tsx`-watch reload does NOT
  re-run them — applying a migration needs a **hard restart**: `aiball restart`
  (wraps `systemctl --user restart aiball`). Add the migration + journal entry
  **before** committing code that reads the new column (else the live daemon
  crashes). See [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md).
- **Daemon lifecycle (#407), mutualised with `claude-loop`:**
  - `aiball restart` (or `kill -HUP $(cat $AIBALL_HOME/daemon.pid)`) → **hard
    restart** — re-runs migrations, reloads all code + env, rebinds the socket.
    `kill -HUP` is **identical to the loop's kill-HUP** (#388). The signal path
    delegates to the supervisor (`systemctl --user restart aiball`) — a self-exit
    can't work because `tsx watch` only relaunches on file changes, not on exit.
    Target `$AIBALL_HOME/daemon.pid` (under `tsx watch` the daemon's pid changes
    on every reload, so use the pidfile, not the systemd MainPID).
  - `aiball reload` (or `kill -USR2 …daemon.pid`) → soft **config reload in
    place, no downtime**. Most config is already read fresh per request, so this
    is mainly for any boot-cached config + revalidation.
- Typecheck backend with `npm run typecheck`; daemon health: `aiball check`
  or `GET /api/health`.

## Docs index

Root:
- [`README.md`](./README.md) — what aiball does + quickstart.
- [`ROADMAP.md`](./ROADMAP.md) — direction, experimental/partial surfaces, planned work.
- [`CHANGELOG.md`](./CHANGELOG.md) — released history (`[Unreleased]` tracks landed-not-tagged).
- [`MCP-CLIENT.md`](./MCP-CLIENT.md) — agent-facing guide to the aiball MCP tools + setups.
- [`.aiball.yaml.example`](./.aiball.yaml.example) — canonical annotated per-project config template.

`docs/`:
- [`INSTALL.md`](./docs/INSTALL.md) — Linux/macOS install modes (hard / `--symlink`), flags, env vars, layout, sanity-checks, troubleshooting.
- [`CONFIGS.md`](./docs/CONFIGS.md) — the layered ("russian-doll") config model: files, layers, precedence per concern.
- [`CLAUDE-LOOP.md`](./docs/CLAUDE-LOOP.md) — the `claude-loop` wrapper: hooks, timer, keystroke detection, state files.
- [`HOOKS.md`](./docs/HOOKS.md) — Claude Code hook events: which aiball wires, which it deliberately doesn't, and why.
- [`SM-NETWORK.md`](./docs/SM-NETWORK.md) — XState v5 state-machine network: per-controller slices, composition root, bridge pattern, add-a-controller checklist.
- [`PTY-PROXY.md`](./docs/PTY-PROXY.md) — the Unix PTY proxy (live human-typing detection).
- [`PTY-PROXY-WINDOWS.md`](./docs/PTY-PROXY-WINDOWS.md) — the Windows ConPTY port.
- [`SANDBOX.md`](./docs/SANDBOX.md) — `aiball sandbox` (experimental autonomous agent).
- [`TAILSCALE.md`](./docs/TAILSCALE.md) — remote access over a tailnet.
- [`REMOTE.md`](./docs/REMOTE.md) — run a local `claude-loop` against a remote daemon: the two types (direct / agent-token vs proxy / node-token).
- [`SECURITY.md`](./docs/SECURITY.md) — trust model & limits (local UDS / direct / proxy-node), with diagrams; the proxy node token is the weak point.
- [`WIN-INSTALL.md`](./docs/WIN-INSTALL.md) — Windows install.
- [`WORKFLOW.md`](./docs/WORKFLOW.md) — `feature` vs mainstream dev workflow (intent-driven; never switch the runtime checkout's branch).
- [`MIGRATIONS.md`](./docs/MIGRATIONS.md) — drizzle/SQLite migration conventions.
- [`I18N.md`](./docs/I18N.md) — i18n policy (English-only today) + proposed approach.
- [`TICKET_LIFECYCLE.md`](./docs/TICKET_LIFECYCLE.md) — TARGET design: ticket states/events + the per-consumer `actionable` gate (`last_actor` model unifying #265/#273/#358).

## Conventions

Owned by [`CONTRIBUTING.md`](./CONTRIBUTING.md) — code in English,
no internal ticket refs in reader-facing docs, versioning source of
truth is `package.json` (surfaced via `aiball --version`,
`/api/health`, the UI footer). See that doc for the full set.
