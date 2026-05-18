# claude-loop

Generic terminal wrapper that makes a Claude Code session "tickable":
a tmux session running `claude` plus a small detached timer process
that wakes the session via `tmux send-keys` every N seconds as long
as claude is idle. Claude itself decides what to do on each wake-up
via its own context (MCP tools, project state, etc) — the wrapper
just keeps it pokeable.

Decoupled from aiball. Any use case where you want claude to react
to external triggers without you typing each prompt works:
cron-like maintenance, mailbox drain, deploy babysitting.

---

## Status — v1 (#B.63)

**Cadence = `--interval` seconds.** The timer fires every N seconds
(default 60). If claude is idle (Stop hook touched the idle-since
marker on its last turn), the timer picks a random wake-up phrase
from the pings YAML and types it into claude. Claude reacts — typically
polls its MCP / state, decides what's actionable, processes it,
goes back to idle. Loop.

For **sub-minute reactivity** (event-driven instead of polling), v2
plan: swap the sleep loop for a unix socket that external triggers
write to. Documented as a follow-up; v1 cadence is enough for most
"check every few minutes" use cases.

---

## Quickstart

```bash
# Spawn + attach (default). `Ctrl-B D` to detach without killing.
claude-loop --name play

# Slower tick (every 5 min instead of every minute)
claude-loop --name slow --interval 300

# Detach immediately (wrapper exits)
claude-loop --no-attach --name bg

# Silent boot — don't send the "check the backlog" startup ping
claude-loop --no-startup-ping

# Inspect / lifecycle
claude-loop list
claude-loop tail bg --lines 30
claude-loop attach bg
claude-loop rm bg
claude-loop prune                  # offers to delete orphan state dirs
```

Default behavior on `start`: **attach immediately** + **send a random
wake-up ping** (via the SessionStart hook, after claude has finished
booting — no race with MCP trust prompts) IF the check-cmd reports
work. Otherwise claude opens silently and the timer takes over.
Flip via `--no-attach` or `--no-startup-ping`.

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│ tmux session cl-<NAME>        (single pane = claude itself)     │
│                                                                 │
│   SessionStart hook ──┐                                         │
│      runs check-cmd   │                                         │
│      → wake if work   ▼                                         │
│   user prompt waits ←── send-keys ←─── detached timer process   │
│                  │                              ▲               │
│   Stop hook ─────┘                              │ tick every    │
│      writes idle-since                          │ CL_INTERVAL   │
│             │                                   │ + check-cmd   │
│             ▼                                   │ (gates wake)  │
│        ~/.claude-loop/<NAME>/idle-since ────────┘               │
└─────────────────────────────────────────────────────────────────┘
                              │
       detached child:  src/claude-loop/timer.ts (tsx)
       logs to ~/.claude-loop/<NAME>/timer.log
```

State dir per loop: `~/.claude-loop/<NAME>/` containing
- `plate.json` — structured config (interval, claude_args, etc)
- `env` — sourced by the Stop hook for CL_* env vars
- `pings.yaml` — copy of the ping phrases (random pick on each fire)
- `idle-since` — touched by Stop hook, removed on wake (ephemeral)
- `wake-requested` — touched by `claude-loop wake <name>` to force
  the next tick (housekeeping; behavior identical to a normal tick)
- `timer.pid` — pid of the detached timer process
- `timer.log` — stdout/stderr of the timer (inspect with `tail --timer`)

Both hooks (SessionStart + Stop) are installed via `claude --settings
'<inline JSON>'` so they apply ONLY to this session — no pollution
of the user's `.claude/settings.json`.

---

## Ping phrases

Random by default, picked from `skill/claude-loop-pings.yaml`. The
phrase is purely cosmetic — claude reads it as "user said X" and
decides what to do (typically check its context, poll for new state,
process whatever). Override with `--pings /path/to/custom.yaml`:

```yaml
ping_messages:
  - "What's up, Doc?"
  - "Wake up, Neo."
  - "Hello, Dave."
  - "Make it so."
  - "Pop quiz, hotshot."
  ...
```

20 pop-culture phrases ship as defaults.

---

## Cadence

The timer fires every `--interval` seconds (default 60). On each
tick:

1. **Is claude idle?** (Stop hook touched `idle-since` on its last
   turn). No → skip the tick.
2. **Is there work?** Run `--check-cmd`. Exit 0 → wake. Non-zero →
   stay idle, wait for the next tick.

`--check-cmd` default = `aiball pings-count -q` (wake when there
are unread pings for the consumer). Optimized path: when using the
default, the timer calls `AiballClient.pingsCount()` in-process
instead of forking a subprocess. Pass `--check-cmd 'your shell'`
for any custom check; pass `--check-cmd true` to disable the gate
entirely and ping every tick.

Manual wake (`claude-loop wake NAME`) bypasses the check-cmd — the
next tick fires regardless of what the check would have said.

---

## wake (manual trigger)

```bash
claude-loop wake aiball-drain
```

Bumps the timer's next tick to fire immediately (without consulting
the check-cmd). Useful when an external process knows there's work
but the check-cmd would miss it. **v1 latency: up to `--interval`
seconds** because the wake is honored on the next sleep wake.

v2 (planned): unix socket replaces the sleep-based timer; wake
becomes sub-second.

---

## Limits

- **Polling cost.** Each loop polls every `interval` seconds. 10 loops
  with 60s interval = 600 forks/hour for the check-cmds alone. Fine
  for typical use; tune up if the check is expensive.
- **No supervision.** If tmux crashes / reboot, the loop is gone.
  Restart by hand (or via systemd timer if you want autopilot).
- **One claude process per loop.** No batching. Each loop is its own
  context.
- **v1 reactivity ceiling.** New events surface within `interval`
  seconds. If you need sub-second, use v2 (socket).

---

## See also

- `bin/claude-loop` — thin bash launcher → `tsx src/claude-loop/cli.ts`
- `src/claude-loop/cli.ts` — Commander-based CLI surface
- `src/claude-loop/state.ts` — state-dir helpers + Plate type +
  `pickPingPhrase()` + `DEFAULT_CHECK_CMD`
- `src/claude-loop/stop-hook.ts` — Stop hook (writes idle-since)
- `src/claude-loop/session-start-hook.ts` — SessionStart hook
  (gates the startup ping on the same check-cmd as the timer)
- `src/claude-loop/timer.ts` — detached timer process (polls,
  send-keys; in-process AiballClient fastpath on default check)
- `skill/claude-loop-pings.yaml` — default ping phrases pool
- `docs/SANDBOX.md` — `aiball sandbox`, the aiball-specific
  specialization (will be refactored to use claude-loop underneath in
  a follow-up)
