# claude-loop

Generic terminal wrapper that makes a Claude Code session "tickable":
a tmux session running `claude` plus a small timer pane that wakes
the session by `tmux send-keys` whenever it's idle AND a user-supplied
check-cmd reports new work.

Decoupled from aiball. Any use case where you want claude to react to
external triggers without you typing each prompt works: cron-like
maintenance, mailbox drain, file-watcher reactions, deploy babysitting.

---

## Status — v1 (#B.63)

**Reactivity = up to `--interval` seconds.** v1 is pure polling — the
timer pane wakes every N seconds (default 60), checks if claude is
idle, runs the check-cmd, and only sends a wake-up message if the cmd
exits 0. So new events trigger a wake within `interval` seconds at
worst.

For **sub-minute reactivity**, swap the polling timer for a unix
socket the external trigger writes to. That's planned as v2 —
straightforward extension of the current state-dir layout. For most
use cases (drain backlog every few minutes), v1 is enough.

---

## Quickstart

```bash
# Spawn + attach (default). `Ctrl-B D` to detach without killing.
claude-loop --name play

# Same, but bound to an aiball ping count check
claude-loop --name aiball-drain --interval 90 \
    --check-cmd 'aiball unread --pings --count-only | grep -qv "^0$"'

# Detach immediately (wrapper exits)
claude-loop --no-attach --name bg

# Skip the startup check-cmd (the timer pings only on its own schedule)
claude-loop --no-startup-check --check-cmd '...'

# Inspect / lifecycle
claude-loop list
claude-loop tail aiball-drain --lines 30
claude-loop attach aiball-drain
claude-loop rm aiball-drain
claude-loop prune                  # offers to delete orphan state dirs
```

Default behavior on `start`: **attach immediately** + **run check-cmd
once on launch** (if it returns 0 the very first wake-up message is
"check the backlog" so claude starts useful). Flip via `--no-attach`
or `--no-startup-check`.

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ tmux session cl-<NAME>                                      │
│                                                             │
│  ┌─ pane 0: claude --settings <Stop hook> ────────────────┐ │
│  │  user prompt waits ← send-keys ← timer pane            │ │
│  └─────────────────┬─────────────────────────────────────┘ │
│                    │ Stop hook → write idle-since           │
│                    ▼                                        │
│           ~/.claude-loop/<NAME>/idle-since                  │
│                    ▲                                        │
│                    │ poll every CL_INTERVAL                 │
│  ┌─ pane 1: timer.sh ────────────────────────────────────┐ │
│  │  while alive:                                          │ │
│  │    sleep N; if idle && check_cmd: send_keys(ping)     │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

State dir per loop: `~/.claude-loop/<NAME>/` containing
- `env` — sourced by the Stop hook and the timer
- `pings.yaml` — copy of the ping phrases (random pick on each fire)
- `idle-since` — touched by Stop hook, removed on wake (ephemeral)
- `wake-requested` — touched by `claude-loop wake <name>` to bypass
  the check-cmd on the next tick

The Stop hook is installed via `claude --settings '<inline JSON>'`
so it applies ONLY to this session — no pollution of the user's
`.claude/settings.json`.

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

## check-cmd

Any shell snippet that exits 0 when there's work to do, non-zero
otherwise. The cmd runs in the timer pane with the loop's env
exported (`CL_NAME`, `CL_STATE_DIR`, `CL_INTERVAL`, `CL_PINGS`).

Examples:
```bash
# Aiball unread pings
--check-cmd 'aiball unread --pings --count-only | grep -qv "^0$"'

# A file's mtime changed since the last tick
--check-cmd '[[ /tmp/wake.flag -nt /tmp/wake.last ]] && touch /tmp/wake.last'

# A queue has work
--check-cmd 'systemctl --user is-active foo-queue.service'

# Always fire (= pure timer)
--check-cmd 'true'
```

Default = `true` (every tick fires).

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
- `src/claude-loop/state.ts` — state-dir helpers + Plate type
- `src/claude-loop/stop-hook.ts` — Stop hook (writes idle-since)
- `src/claude-loop/timer.ts` — detached timer process (polls, send-keys)
- `skill/claude-loop-pings.yaml` — default ping phrases pool
- `docs/SANDBOX.md` — `aiball sandbox`, the aiball-specific
  specialization (will be refactored to use claude-loop underneath in
  a follow-up)
