# aiball — agent guide

aiball is a local-first, event-driven board that turns Claude Code
sessions into persistent, remotely-pilotable agents (one per project).
Daemon (Express + SQLite/Drizzle) + Vue frontend + the `claude-loop`
tmux wrapper + a stdio MCP server. See [`README.md`](./README.md).

## How this checkout runs (read before editing)

- **The dev checkout IS the live runtime.** `~/.local/lib/aiball` symlinks
  here; the daemon + `claude-loop` run the source via `tsx` (no build step).
- **Frontend edits need a rebuild**: `cd frontend && npm run build` —
  `tsx`/`vue-tsc` only typecheck, they don't emit `dist/` (which the daemon
  serves). Hard-reload the browser after.
- **DB migrations only run at daemon boot.** A `tsx`-watch reload does NOT
  re-run them — applying a migration needs `systemctl --user restart aiball`.
  Add the migration + journal entry **before** committing code that reads
  the new column (else the live daemon crashes). See [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md).
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
- [`CONFIGS.md`](./docs/CONFIGS.md) — the layered ("russian-doll") config model: files, layers, precedence per concern.
- [`CLAUDE-LOOP.md`](./docs/CLAUDE-LOOP.md) — the `claude-loop` wrapper: hooks, timer, keystroke detection, state files.
- [`PTY-PROXY.md`](./docs/PTY-PROXY.md) — the Unix PTY proxy (live human-typing detection).
- [`PTY-PROXY-WINDOWS.md`](./docs/PTY-PROXY-WINDOWS.md) — the Windows ConPTY port.
- [`SANDBOX.md`](./docs/SANDBOX.md) — `aiball sandbox` (experimental autonomous agent).
- [`TAILSCALE.md`](./docs/TAILSCALE.md) — remote access over a tailnet.
- [`WIN-INSTALL.md`](./docs/WIN-INSTALL.md) — Windows install.
- [`WORKFLOW.md`](./docs/WORKFLOW.md) — `feature` vs mainstream dev workflow (intent-driven; never switch the runtime checkout's branch).
- [`MIGRATIONS.md`](./docs/MIGRATIONS.md) — drizzle/SQLite migration conventions.
- [`I18N.md`](./docs/I18N.md) — i18n policy (English-only today) + proposed approach.

## Conventions

- User-facing strings + docs are **English**; code comments are French (see [`docs/I18N.md`](./docs/I18N.md)).
- Versioning: source of truth is `package.json` (qcmp `aiball` component); surfaced via `aiball --version`, `/api/health`, the UI footer.
