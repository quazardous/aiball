# aiball roadmap

Where aiball is going, what's half-built, and what's deliberately parked.
Refer here when something in the README points to a "see ROADMAP".

Shipped history lives in [`CHANGELOG.md`](./CHANGELOG.md) — its
`[Unreleased]` section tracks landed-but-not-tagged work. This file is
forward-looking only.

## Direction

The frame the hero diagram sketches: aiball as an **event-driven layer
for persistent, per-project coding agents**. You pilot N `claude-loop`
sessions — one per repo, each a long-lived specialized agent — all
monitorable and steerable from one local-first board. The rest of this
file is the gap between that picture and today.

Two principles anchor every design choice:

- **Two focuses, one tool.** aiball optimizes for *your* focus (don't
  nag the human: moderation, wake cooldowns, decisions that wait for
  you) **and** for the *agent's* focus (a per-project backlog, one wake
  at a time, a work order instead of loudest-first). The two pull in
  opposite directions, so most mechanisms — cooldowns, gates, drained
  reminders — are deliberate trade-offs between them, with explicit
  bounds.
- **Hybrid by design.** A looped session is not a black box: it's your
  normal Claude Code terminal with a coach attached. Grab the keyboard
  and drive it live, or feed it tickets and walk away — same session,
  same context, switch whenever. The loop notices you typing and steps
  aside, then resumes draining when you leave. This direct+backlog
  duality is the core of the product.

Where that leads:

- **Persistent specialized agents** — one agent per project, kept alive
  across turns with its own backlog (and, eventually, long-term
  memory), instead of one-shot sessions. In practice **one agent per
  repo has proven the right grain for context focus** — pooling several
  agents on one repo is parked (see Parked).
- **Inter-project communication** — tickets / pings / comments already
  cross projects; the direction is richer cross-folder hand-off between
  agents.
- **Deep-work offload** — queue work and walk away; the agent drains
  asynchronously between turns. Largely real today via `claude-loop`;
  what's left is hardening.

These are *direction*, not commitments. Concrete near-term work is under
Planned; rough-but-usable surfaces under Experimental / partial;
consciously paused threads under Parked.

## Planned

### Web terminal

View a loop's live terminal — the tmux pane — straight in the web UI
(and over Tailscale, from your phone), instead of only `claude-loop tail`
/ `attach` from a shell. The pane is already captured for the bar-state
probe; piping it to the browser is in the pipeline.

### Windows hardening

The install ships end-to-end — daemon, `aiball` CLI, `aiball-mcp`,
system-tray icon, all driven by `install.ps1`
(`-Minimal` / `-Service` / `-System` / `-Symlink` variants). See
[`docs/WIN-INSTALL.md`](./docs/WIN-INSTALL.md).

`claude-loop` runs via [psmux](https://github.com/psmux/psmux) — a `tmux`
alias covering the 6-7 ops the wrapper uses (`has-session`,
`new-session`, `send-keys`, `capture-pane`, `set-option`, `bind-key`,
`kill-session`); the existing `MUX_CMD` indirection finds it with no code
change — or under WSL2. Live keystroke detection has a Rust ConPTY proxy
(see [`docs/PTY-PROXY-WINDOWS.md`](./docs/PTY-PROXY-WINDOWS.md)).

Remaining is parity hardening, not a from-scratch port:
- **NSSM-based service alternative** to the Scheduled Task, for
  service-manager auto-restart on crash.
- Routine multi-hour testing of the psmux / ConPTY path (currently
  smoke-level).

## Experimental / partial

### Sandbox loop

`aiball sandbox start --tickets "10,11"` spawns an autonomous Claude
Code session in tmux against a fixed plate of tickets. Full guide:
[`docs/SANDBOX.md`](./docs/SANDBOX.md).

**Works**: the happy path (spawn → process the plate → exit when done),
*and* auto-respawn on new pings — the daemon's `src/sandbox/watcher.ts`
cron re-launches a dead sandbox when fresh pings land for its agent
(throttled via `watcher.json`).

**Missing for daily-driver status**:
- Graceful degradation on Claude Code rate-limits / API errors — the
  dumb exponential backoff `claude-loop` got
  (`error-backoff.ts`) is **not** wired into the sandbox path yet.
- Anti-oscillation hardening — the loop relies on the agent honoring
  conventions (e.g. resolving/escalating); bad behavior can bounce a
  ticket forever.
- Not stress-tested in multi-hour autonomous runs (smoke tests cover
  trivial tickets only).

For the autonomous wrapping you actually want today, use
[`claude-loop`](./README.md#quickstart--claude-loop-recommended).
Refactoring sandbox to run on `claude-loop` underneath is a noted
follow-up; it's kept for experimentation — caveat emptor. Active
development on the sandbox is **on pause** (see Parked below for the
reasoning); `claude-loop` is the daily driver.

## Parked (deliberately)

### Multiple agents on one project (sandbox pool + worktrees)

The original plan: run **several loop agents against a single folder** at
once, each isolated in its own **git worktree**, orchestrated as a pool
from aiball. The isolation primitive exists and works — `aiball sandbox
--worktree` spawns a sandbox on a fresh `git worktree add` (branch
`sandbox/<name>`), so two sandboxes can edit the same repo without
conflict.

Paused after real-world use, on purpose: **one agent per project turned
out to be the right grain for context focus.** A single long-lived
session per repo keeps the conversation coherent, and the hybrid
direct+backlog piloting (see Direction) covers the "more hands" need
better than a pool would — when you need to intervene, you type in the
same terminal the agent lives in, instead of coordinating N of them. The
worktree isolation stays available; pool orchestration will be revisited
if a use case actually demands it.

## Open ideas (not committed)

- **Consumer panel over SSE** — the consumer state
  *push* shipped (`pushState`: loop/idle/busy + the human-presence word land on
  the daemon), but the consumers panel still polls ~30s to read it.
  Wiring the panel to the existing SSE event-bus would repaint it
  instantly. Cheap now that the push side exists.
- **claude-loop transcript reader** — instead of pane-scraping the
  `esc to interrupt` footer, read claude-code's JSONL transcript at
  `~/.claude/projects/<hash>/<id>.jsonl` for authoritative turn
  boundaries. Heavier, marginal payoff.
- **`aiball check` deprecation-warning symmetry** — the
  autopoll Stop hook (`hook-stop.ts`) doesn't surface the
  deprecated-identity warning that `claude-loop` and `aiball check`
  already do. Low value (its stderr isn't user-visible); wire only if a
  use case shows up.
