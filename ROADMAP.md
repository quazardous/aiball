# aiball roadmap

Work-in-flight, experimental surfaces, and known partial features.
Refer here when something in the README points to a "see ROADMAP".

## Experimental / partial

### Sandbox loop (`#B.183`)

`aiball sandbox start --tickets "10,11"` spawns an autonomous Claude
Code session in tmux against a fixed plate of tickets.

**Works**: the happy path (spawn → process the plate → exit when
done). The full guide is at [`docs/SANDBOX.md`](./docs/SANDBOX.md).

**Missing for daily-driver status**:
- Auto-respawn on new pings (today the loop exits when the plate is
  drained; a fresh ping doesn't re-launch it).
- Graceful degradation on Claude Code rate-limits / API errors.
- Anti-oscillation hardening (the loop relies on the agent following
  conventions like marking tickets `escalated` — bad behavior can
  bounce a ticket forever).

For autonomous wrapping you actually want today, use
[`claude-loop`](./README.md#quickstart--claude-loop-recommended).
Sandbox is kept around for experimentation; caveat emptor.

### claude-loop on Windows (`#B.178`)

Daemon-only Windows install scaffold ships (see
[`docs/WIN-INSTALL.md`](./docs/WIN-INSTALL.md)) — daemon + `aiball`
CLI + `aiball-mcp` work, with the daemon registered as a per-user
Scheduled Task.

**Missing**: `claude-loop` wrapper port. Needs an adapter for a
Windows-native multiplexer (psmux is the current candidate —
<https://github.com/psmux/psmux>). The wrapper's tmux surface is
small (~6 operations: new-session / send-keys / capture-pane /
set-option / has-session / kill-session), so the port is ~50 LOC
in `src/claude-loop/state.ts` once a multiplexer with that surface
is confirmed.

### `aiball check` autopoll deprecation warning symmetry (`#B.154`)

`claude-loop` warns on stderr when `.mcp.json` carries the deprecated
identity env block. `aiball check` surfaces the warning in its
"deprecation" section. The autopoll hook (`hook-stop.ts`) doesn't —
its stderr isn't user-visible so the value is low. Could be wired
for symmetry if a use case shows up.

## Open ideas (not committed)

- **Consumer activity SSE** — the `Activity` column in the consumers
  panel (#B.177) polls every ~30s. Could push state changes via the
  existing SSE event-bus for instant feedback. Cheap once the
  push-state endpoint exists.
- **NSSM-based service alternative** to the Windows Scheduled Task
  for users who want service-manager auto-restart on crash.
- **claude-loop transcript reader** — instead of pane-scraping
  (`esc to interrupt` regex), read claude-code's JSONL transcript at
  `~/.claude/projects/<hash>/<id>.jsonl` for authoritative turn
  boundaries. Heavier, marginal payoff per #B.172 design notes.

## Past iterations worth remembering

See `CHANGELOG.md` for what shipped in each release. The
`[Unreleased]` section at the top tracks work landed-but-not-tagged.
