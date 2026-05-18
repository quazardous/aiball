# claude-loop

> Wrap a Claude Code session in a tmux loop that wakes itself when
> there's work to drain. Default-coupled to aiball (the wake-up gate
> polls `aiball pings-count`); generic via `--check-cmd <shell>`.

---

## What it is

A pseudo "timer hook" for Claude Code. Claude Code is event-driven —
no native `Tick`/`Periodic` hook — but you sometimes want a session
that quietly drains pings as they arrive without you typing each
prompt. `claude-loop` adds that behavior externally:

- **tmux** owns the lifetime of the session (`cl-<NAME>` session
  named after the loop).
- **An inline `claude --settings '<JSON>'` block** installs two
  hooks scoped to that session only (no pollution of your
  `~/.claude/settings.json`):
  - `SessionStart` — fires after claude has booted.
  - `Stop` — fires at the end of every claude turn.
- **A detached timer process** ticks every `CL_INTERVAL` seconds.

Each surface asks the same question — _is there work?_ — by running
the loop's `--check-cmd`. Exit 0 → wake claude with a random
pop-culture phrase. Non-zero → mark idle, wait.

---

## Core cycle

```
                           ┌─────────────────────────────┐
       boot ──► SessionStart hook ──► check-cmd ?        │
                              │       ├─ exit 0 → send-keys phrase
                              │       └─ non-0  → write idle-since
                              ▼
                    ┌────────────────────────┐
                    │  claude waits at prompt │ ◄─────┐
                    └──────────┬──────────────┘       │
                               │ user types OR        │ send-keys
                               │ send-keys arrives    │
                               ▼                      │
                    ┌────────────────────────┐        │
                    │  claude runs a turn     │        │
                    └──────────┬──────────────┘        │
                               │                       │
                               ▼                       │
                       Stop hook ──► check-cmd ?       │
                              │     ├─ exit 0 → send-keys phrase ──┘
                              │     └─ non-0  → write idle-since
                              ▼
                      (back to "waits at prompt")

         in parallel, every CL_INTERVAL seconds:
         ┌──────────────────────────────────────────┐
         │ timer process: idle-since present?       │
         │   ├─ no  → skip tick (claude is busy)    │
         │   └─ yes → wake-requested or check-cmd? │
         │            ├─ yes → send-keys phrase     │
         │            └─ no  → skip tick (stay idle)│
         └──────────────────────────────────────────┘
```

**Three wake sources**, all gated through the same `checkHasWork()`
function (except `wake` which is unconditional):

| Surface         | When                              | Latency from event arrival |
|-----------------|-----------------------------------|----------------------------|
| Stop hook       | Just after claude finishes a turn | ~immediate                 |
| SessionStart    | After claude boots                | ~immediate (once)          |
| Timer tick      | Every `CL_INTERVAL` seconds       | up to `CL_INTERVAL` sec    |
| `claude-loop wake` | Manual external trigger        | up to `CL_INTERVAL` sec    |

The Stop hook is the tightest drain: as soon as claude returns to
the prompt with new work waiting, it re-fires without waiting for
the timer.

---

## Quickstart

```bash
# Spawn + attach (default). Ctrl-B D to detach.
claude-loop --name play

# Slower tick (every 5 min). Default check-cmd = aiball pings.
claude-loop --interval 300

# Bound to a non-aiball check
claude-loop --check-cmd 'curl -fs http://localhost/api/queue?count=1 | jq -e .pending'

# Pure timer (ping every tick, no gating)
claude-loop --check-cmd true

# Detach immediately, don't send the boot ping
claude-loop --no-attach --no-startup-ping

# Pass options to claude itself (after --)
claude-loop -- --model opus -p "kick off drain"
```

Lifecycle:

```bash
claude-loop list                       # alive/dead + state summary
claude-loop tail <name> --lines 30     # last N lines of the claude pane
claude-loop tail <name> --timer        # detached timer's stdout log
claude-loop attach <name>              # tmux attach
claude-loop wake <name>                # force the next tick (bypass check-cmd)
claude-loop rm <name> [--force]        # kill tmux + timer + state dir
claude-loop prune                      # interactive cleanup of orphans
```

---

## check-cmd contract

Any shell snippet:

- **Exit 0** = "there is work to drain" → wake claude.
- **Non-zero** = "nothing to do" → stay idle.

Default: `aiball pings-count -q`. The CLI subcommand prints the
unread-ping count and exits 0 when > 0. When this exact string is
the check-cmd, both the timer and the hooks bypass the subprocess
fork and call `AiballClient.pingsCount()` directly in-process
(cached client, keep-alive socket).

Special values:
- `true` (or empty) → wake unconditionally on every tick (pure
  timer mode).

Custom shells (e.g., file watchers, queue checks, hybrid logic) get
shelled out per tick — no fastpath, but anything works.

---

## State layout

`~/.claude-loop/<NAME>/` (override via `CLAUDE_LOOP_STATE_ROOT`):

| File              | Writer          | Purpose                                   |
|-------------------|-----------------|-------------------------------------------|
| `plate.json`      | cli on start    | structured config (interval, check_cmd…)  |
| `env`             | cli on start    | bash-sourceable CL_* env vars             |
| `pings.yaml`      | cli on start    | copy of the wake-phrase pool              |
| `idle-since`      | Stop / SessionStart sleep branch | claude is at prompt since X |
| `wake-requested`  | `claude-loop wake` | one-shot trigger for the next tick    |
| `timer.pid`       | cli on start    | pid of the detached timer (used by `rm`)  |
| `timer.log`       | timer (stdout/err) | inspect via `tail --timer`             |

The hooks and the timer all read the same `env` file so they share
`CL_NAME`, `CL_STATE_DIR`, `CL_INTERVAL`, `CL_CHECK_CMD`, `CL_PINGS`,
`CL_NO_STARTUP_PING`.

---

## Wake phrases

Random pick per wake from `skill/claude-loop-pings.yaml`:

```yaml
ping_messages:
  - "What's up, Doc?"
  - "Wake up, Neo."
  - "Hello, Dave."
  - "Make it so."
  - "Allons-y!"
  ...
```

20 default pop-culture phrases ship; override per-loop with
`--pings /path/to/custom.yaml`. The phrase is purely cosmetic —
claude reads "user typed X", inspects its context, decides what to
do. The wrapper doesn't try to know what "work" is.

---

## Files

```
bin/claude-loop                         # thin bash launcher → tsx
src/claude-loop/
  cli.ts                                # Commander CLI surface
  state.ts                              # Plate + helpers + pickPingPhrase + DEFAULT_CHECK_CMD
  session-start-hook.ts                 # boot gate: check-cmd → ping or idle
  stop-hook.ts                          # turn-end gate: same logic
  timer.ts                              # detached ticker; AiballClient fastpath
skill/claude-loop-pings.yaml            # default wake phrases
docs/CLAUDE-LOOP.md                     # this file
```

Install symlinks `~/.local/bin/claude-loop` alongside `aiball` and
`aiball-mcp` (see `install.sh`).

---

## Properties

- Three wake surfaces share the same `checkHasWork()` contract,
  predictable behavior across boot / drain / tick.
- Hooks scoped to one session via inline `--settings` JSON — zero
  pollution of the user's global Claude Code config.
- Timer is decoupled from the tmux process tree (`nohup` + `unref`),
  survives detach but dies cleanly when tmux exits (polls
  `has-session`).
- Generic-by-design: any shell can serve as `--check-cmd`; the
  aiball default is just the most common case.
- Wake-gate fastpath: when the default check is in use, the timer
  reuses `AiballClient` in-process instead of forking a subprocess.

---

## Limits

- **Polling cost.** 1 check-cmd run per loop per `CL_INTERVAL`.
  10 loops × 60s = 600 checks/hour, fine for the default
  (`AiballClient.pingsCount()` is a 1-HTTP-call probe).
- **One claude per loop.** Each loop holds its own context window;
  no batching.
- **tmux required.** No `screen` fallback yet (would be a small
  refactor — `MUX_CMD` is already a configurable constant).
- **Hooks fire only inside their own loop session.** A SessionStart
  hook from one loop doesn't see another loop's state.

---

## See also

- `docs/SANDBOX.md` — `aiball sandbox`, the aiball-specific
  specialization that predates `claude-loop`. Refactoring it to use
  `claude-loop` underneath is a noted follow-up.
- `CHANGELOG.md` — narrative history (`[Unreleased]` section
  covers this work).
- `MCP-CLIENT.md` — agent-facing docs on aiball MCP usage; the
  default check-cmd (`aiball pings-count`) ties claude-loop to the
  flows described there.
